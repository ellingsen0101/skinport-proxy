const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const CACHE_MS = 5 * 60 * 1000;

let cachedBody = "";
let cachedAt = 0;

function readResponse(response) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		response.on("data", chunk => chunks.push(chunk));
		response.on("end", () => {
			const buffer = Buffer.concat(chunks);
			const encoding = String(response.headers["content-encoding"] || "").toLowerCase();

			if (encoding === "br") {
				zlib.brotliDecompress(buffer, (err, decoded) => {
					if (err) {
						reject(err);
					} else {
						resolve(decoded.toString("utf8"));
					}
				});
				return;
			}

			if (encoding === "gzip") {
				zlib.gunzip(buffer, (err, decoded) => {
					if (err) {
						reject(err);
					} else {
						resolve(decoded.toString("utf8"));
					}
				});
				return;
			}

			resolve(buffer.toString("utf8"));
		});
		response.on("error", reject);
	});
}

function fetchSkinport(currency, tradable) {
	const upstreamUrl = new URL("https://api.skinport.com/v1/items");
	upstreamUrl.searchParams.set("app_id", "730");
	upstreamUrl.searchParams.set("currency", currency);
	upstreamUrl.searchParams.set("tradable", tradable);

	return new Promise((resolve, reject) => {
		const req = https.get(upstreamUrl, {
			headers: {
				"Accept-Encoding": "br, gzip",
				"User-Agent": "RobloxSkinportPriceProxy/1.0",
			},
		}, async response => {
			try {
				const body = await readResponse(response);
				if (response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(`Skinport HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
					return;
				}
				resolve(body);
			} catch (err) {
				reject(err);
			}
		});

		req.setTimeout(30000, () => {
			req.destroy(new Error("Skinport request timed out"));
		});
		req.on("error", reject);
	});
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const currency = (url.searchParams.get("currency") || "USD").toUpperCase();
		const tradable = url.searchParams.get("tradable") || "0";

		if (req.method !== "GET") {
			res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
			res.end("Method not allowed");
			return;
		}

		if (!cachedBody || Date.now() - cachedAt > CACHE_MS) {
			cachedBody = await fetchSkinport(currency, tradable);
			cachedAt = Date.now();
		}

		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300",
		});
		res.end(cachedBody);
	} catch (err) {
		res.writeHead(502, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(String(err && err.message || err));
	}
});

server.listen(PORT, () => {
	console.log(`Skinport proxy listening on port ${PORT}`);
});
