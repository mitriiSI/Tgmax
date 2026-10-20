import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { lookup as systemLookup } from 'node:dns';
import net from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DNS_CACHE = new Map();
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const DOH_ENDPOINTS = [
  {
    hostname: 'dns.google',
    addresses: ['8.8.8.8', '8.8.4.4'],
    path: (name) => `/resolve?name=${encodeURIComponent(name)}&type=A`
  },
  {
    hostname: 'cloudflare-dns.com',
    addresses: ['1.1.1.1', '1.0.0.1'],
    path: (name) => `/dns-query?name=${encodeURIComponent(name)}&type=A`
  }
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function systemLookupPromise(hostname, options) {
  return new Promise((resolve, reject) => {
    systemLookup(hostname, { all: true, verbatim: false, ...options }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

function queryDohEndpoint(endpoint, hostname, timeoutMs) {
  return new Promise((resolve, reject) => {
    let addressIndex = 0;
    const request = https.get({
      protocol: 'https:',
      hostname: endpoint.hostname,
      servername: endpoint.hostname,
      path: endpoint.path(hostname),
      headers: {
        accept: 'application/dns-json',
        'user-agent': DEFAULT_USER_AGENT
      },
      lookup(_hostname, options, callback) {
        const address = endpoint.addresses[addressIndex % endpoint.addresses.length];
        addressIndex += 1;
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      }
    }, async (response) => {
      try {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          drain(response);
          reject(new Error(`DoH HTTP ${response.statusCode}`));
          return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw new Error('DoH response is too large');
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.setTimeout(Math.min(timeoutMs, 10_000), () => {
      request.destroy(new Error('DoH timeout'));
    });
    request.once('error', reject);
  });
}

async function queryDoh(hostname, timeoutMs) {
  let lastError;
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const payload = await queryDohEndpoint(endpoint, hostname, timeoutMs);
      const addresses = (payload.Answer ?? [])
        .filter((answer) => answer.type === 1 && net.isIP(answer.data) === 4)
        .map((answer) => ({ address: answer.data, family: 4 }));
      if (addresses.length) {
        const ttlSeconds = Math.max(30, Math.min(600, Number(payload.Answer?.[0]?.TTL) || 120));
        DNS_CACHE.set(hostname, { addresses, expiresAt: Date.now() + ttlSeconds * 1000 });
        return addresses;
      }
      throw new Error('DoH did not return an IPv4 address');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`Could not resolve ${hostname} through DoH`);
}

export async function resolveHostnameResilient(hostname, { timeoutMs = 20_000 } = {}) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  const cached = DNS_CACHE.get(hostname);
  if (cached?.expiresAt > Date.now()) return cached.addresses;

  try {
    return await queryDoh(hostname, timeoutMs);
  } catch (dohError) {
    try {
      return await systemLookupPromise(hostname, { family: 4 });
    } catch (systemError) {
      throw new Error(`DNS не смог определить адрес ${hostname}`, { cause: systemError ?? dohError });
    }
  }
}

export function createResilientLookup({ timeoutMs = 20_000 } = {}) {
  return (hostname, options, callback) => {
    resolveHostnameResilient(hostname, { timeoutMs })
      .then((addresses) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => callback(error));
  };
}

function requestOnce(url, { headers, timeoutMs, useResilientDns }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.get(target, {
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: '*/*',
        'accept-language': 'ru,en;q=0.8',
        ...headers
      },
      ...(useResilientDns ? { lookup: createResilientLookup({ timeoutMs }) } : {})
    }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP timeout after ${timeoutMs} ms`)));
    request.once('error', reject);
  });
}

function drain(response) {
  response.resume();
}

async function openResponse(inputUrl, {
  headers = {},
  timeoutMs = 20_000,
  maxRedirects = 6,
  forceResilientDns = true
} = {}) {
  let currentUrl = inputUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let response;
    try {
      response = await requestOnce(currentUrl, {
        headers,
        timeoutMs,
        useResilientDns: forceResilientDns
      });
    } catch (error) {
      if (forceResilientDns) throw error;
      response = await requestOnce(currentUrl, { headers, timeoutMs, useResilientDns: true });
    }

    const status = Number(response.statusCode) || 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      drain(response);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { response, finalUrl: currentUrl, status };
  }
  throw new Error('слишком много перенаправлений при скачивании');
}

export async function fetchTextResilient(url, options = {}) {
  const { response, finalUrl, status } = await openResponse(url, options);
  if (status < 200 || status >= 300) {
    drain(response);
    throw new Error(`веб-страница Telegram вернула HTTP ${status}`);
  }
  const chunks = [];
  let bytes = 0;
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      response.destroy();
      throw new Error('веб-страница Telegram оказалась слишком большой');
    }
    chunks.push(chunk);
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    finalUrl,
    contentType: response.headers['content-type'] ?? ''
  };
}

class DownloadLimit extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.maxBytes && this.bytes > this.maxBytes) {
      callback(new Error(`исходный файл больше лимита скачивания ${this.maxBytes} байт`));
      return;
    }
    callback(null, chunk);
  }
}

export async function downloadUrlResilient(url, destinationPath, options = {}) {
  let lastError;
  const attempts = Math.max(1, options.attempts ?? 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, finalUrl, status } = await openResponse(url, options);
      if (status < 200 || status >= 300) {
        drain(response);
        throw new Error(`сервер медиа вернул HTTP ${status}`);
      }
      const announcedSize = Number(response.headers['content-length']);
      if (options.maxBytes && Number.isFinite(announcedSize) && announcedSize > options.maxBytes) {
        drain(response);
        throw new Error(`исходный файл больше лимита скачивания ${options.maxBytes} байт`);
      }
      const limiter = new DownloadLimit(options.maxBytes);
      await pipeline(response, limiter, createWriteStream(destinationPath));
      return {
        bytes: limiter.bytes,
        finalUrl,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0].trim()
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(500 * attempt);
    }
  }
  throw lastError;
}
