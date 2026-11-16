# Troubleshoot deployment asset and origin errors

## Symptoms and impact

The public game page returned HTML, but the browser could not apply the stylesheet or load the JavaScript bundle. DevTools reported a stylesheet MIME error for `application/json` and a `403` for JavaScript. Requests carrying the same frontend origin also failed at `/api/platform` and the Socket.IO handshake, so loading the game shell alone did not restore play.

A separate `/favicon.ico` request returned `404` during the initial check. The client now declares its existing icon in the HTML. A later check received `502` for both the stylesheet and `/api/platform`. The live origin fix remains unverified, and the upstream cause of the `502` was not established.

## Reproduce and identify the response

1. Open DevTools, enable **Disable cache** in the Network tab, and reload the game. Find the stylesheet and JavaScript requests and inspect their status, content type, request `Origin`, and response body.
2. Copy the asset paths from the HTML of the current release. Vite includes a content hash in these filenames, so a path from an older release may return `404`.
3. Compare the same stylesheet request with and without the browser's `Origin` header. Use the exact frontend origin, including the scheme and any non-default port. Leave out the path and trailing slash in the header.

```sh
PUBLIC_ORIGIN='<scheme>://<public-host>'
CSS_PATH='/assets/<current-stylesheet>.css'
JS_PATH='/assets/<current-script>.js'

curl -sS -D - -o /dev/null "$PUBLIC_ORIGIN$CSS_PATH"
curl -sS -D - -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN$CSS_PATH"
curl -sS -D - -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN/api/platform"
```

| Observed response | What to check |
| --- | --- |
| `200 text/css` without `Origin`, then `403 application/json` with `Origin` | Read the response body. `Origin is not allowed.` identifies an origin allowlist rejection. |
| `404` for a current CSS or JavaScript path | Check whether the deployed HTML and asset directory came from the same build. |
| `200 text/html` for a CSS or JavaScript path | Check whether a proxy or SPA fallback served `index.html` for an asset request. |
| `502` for assets and API | Check the proxy or tunnel's connection to Node, the configured backend port, and the Node startup logs. Resume origin checks once the upstream responds. |
| Sign-in returns `500` and the log shows `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` | The proxy adds `X-Forwarded-For` but `http.trustProxy` is `false`. See [trustProxy](#behind-a-tunnel-or-reverse-proxy-also-set-trustproxy). |

## Developer findings

The CSS asset existed and Express served it as `text/css` when the request omitted `Origin`. The request with `Origin` reached the HTTP origin middleware first. The effective allowlist lacked the frontend origin, so the middleware returned this response before static serving ran.

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8

{"protocolVersion":1,"message":"Origin is not allowed."}
```

The browser rejected that JSON response when it tried to use it as CSS. The JavaScript request hit the same HTTP guard. The API uses that allowlist too, and Socket.IO applies the same origin set during its handshake. See [HTTP and Socket.IO application setup](../apps/server/src/application.ts) and [the HTTP origin middleware](../apps/server/src/http/origin-policy.ts).

## Apply the fix

Add the exact public frontend origin to the service's configuration, then restart. There is no deployment-specific startup flag: the origin allowlist is ordinary configuration.

Use one of these, in order of preference:

1. **Operator file (recommended).** Copy [deploy/profiles/cloudflare-tunnel.example.json](../deploy/profiles/cloudflare-tunnel.example.json) to a non-committed name such as `deploy/profiles/cloudflare-tunnel.local.json`, replace the origin with your hostname, and start with `CONFIG_FILE` pointing at it.
2. **Environment.** Set `ALLOWED_ORIGINS` to the comma-separated list. This **replaces** the profile list, so include every origin the deployment needs.

```sh
npm run build
CONFIG_FILE=deploy/profiles/cloudflare-tunnel.local.json npm start
```

Keep the service's current working directory, database path, and instance identity. The database is bound to the `instanceId`/`purpose` pair on first use, so a profile that changes either value is rejected at startup with `Invalid configuration: database instance identity`.

For a different deployment, add its exact frontend origin to the service's comma-separated `ALLOWED_ORIGINS` value and retain other required origins. If the service uses only `CONFIG_FILE`, add it to that file's `origins` list. During a normal startup, an environment `ALLOWED_ORIGINS` value replaces the list in the file. Restart Node after changing either setting. See [configuration precedence](configuration-architecture.md#loading-and-precedence).

### Behind a tunnel or reverse proxy, also set `trustProxy`

A tunnel or nginx hop adds `X-Forwarded-For`. With the default `http.trustProxy: false`, `express-rate-limit` raises `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every authentication request and cannot identify clients. Set `http.trustProxy: "loopback"` **only** when the proxy is on the same host and overwrites the forwarding headers. Broad trust (`true`, `*`, CIDR strings) is rejected by the schema.

```json
{ "http": { "host": "127.0.0.1", "trustProxy": "loopback" } }
```

`http.host` defaults to `127.0.0.1`, so the backend is not reachable from the network unless you explicitly set `HOST`. Keep it on loopback and let the tunnel or proxy connect locally.

## Verify after restart

Run these requests with the same `PUBLIC_ORIGIN`, `CSS_PATH`, and `JS_PATH` variables. Recapture the asset paths from the deployed HTML if the release was rebuilt.

```sh
curl -fsS -D - -o /dev/null -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN$CSS_PATH"
curl -fsS -D - -o /dev/null -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN$JS_PATH"
curl -fsS -D - -o /dev/null -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN/api/platform"
curl -fsS -D - -o /dev/null -H "Origin: $PUBLIC_ORIGIN" "$PUBLIC_ORIGIN/socket.io/?EIO=4&transport=polling"
```

- Expect `200` with a CSS content type for the stylesheet, a JavaScript content type for the script, and `application/json` for the platform endpoint.
- Expect `200` for Socket.IO polling. Sign in and open the game in a browser to verify the authenticated connection. The polling response alone only confirms transport admission.
- Confirm the browser loads the favicon declared by the current HTML and renders the game without the MIME error or origin rejection.

The built server passed all four origin checks locally. It also accepted an existing allowlist entry and rejected an unlisted origin. The startup, browser navigation, and configuration suites passed all 38 focused tests. The final public check returned `502`. Successful local checks leave proxy routing and live deployment verification open.
