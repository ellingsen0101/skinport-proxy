const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;

const cache = new Map();

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

function buildSkinportUrl(endpoint, currency, tradable) {
	const upstreamUrl = new URL(endpoint === "out-of-stock"
		? "https://api.skinport.com/v1/sales/out-of-stock"
		: "https://api.skinport.com/v1/items");
	upstreamUrl.searchParams.set("app_id", "730");
	upstreamUrl.searchParams.set("currency", currency);
	if (endpoint !== "out-of-stock") {
		upstreamUrl.searchParams.set("tradable", tradable);
	}

	return upstreamUrl;
}

function fetchSkinport(endpoint, currency, tradable) {
	const upstreamUrl = buildSkinportUrl(endpoint, currency, tradable);
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
		const endpoint = (url.searchParams.get("endpoint") || "items").toLowerCase();
		const currency = (url.searchParams.get("currency") || "USD").toUpperCase();
		const tradable = url.searchParams.get("tradable") || "0";

		if (req.method !== "GET") {
			res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
			res.end("Method not allowed");
			return;
		}

		if (endpoint !== "items" && endpoint !== "out-of-stock") {
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
			res.end("Unknown endpoint");
			return;
		}

		const cacheKey = buildSkinportUrl(endpoint, currency, tradable).toString();
		const cacheTtl = endpoint === "out-of-stock" ? 60 * 60 * 1000 : 5 * 60 * 1000;
		let cached = cache.get(cacheKey);
		if (!cached || Date.now() - cached.at > cacheTtl) {
			cached = {
				body: await fetchSkinport(endpoint, currency, tradable),
				at: Date.now(),
			};
			cache.set(cacheKey, cached);
		}

		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${Math.floor(cacheTtl / 1000)}`,
		});
		res.end(cached.body);
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
