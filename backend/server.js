const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// ---------- Proxy rotator ----------
let proxyList = [];
let proxyIndex = 0;

async function fetchProxyList() {
    return new Promise((resolve) => {
        const url = 'https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http';
        https.get(url, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    proxyList = parsed.data.map(p => `http://${p.ip}:${p.port}`);
                    console.log(`Fetched ${proxyList.length} proxies`);
                } catch (e) {
                    console.warn('Failed to parse proxy list');
                }
                resolve();
            });
        }).on('error', (e) => {
            console.warn('Proxy list fetch error:', e.message);
            resolve();
        });
    });
}

function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[proxyIndex % proxyList.length];
    proxyIndex++;
    return proxy;
}

// Fetch proxies immediately (non‑blocking) and then every 30 minutes
fetchProxyList();
setInterval(fetchProxyList, 30 * 60 * 1000);

// ---------- yt-dlp helper (with fallback proxies) ----------
function ytDlp(args, proxy = null) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = ['--js-runtime', 'node'];
        if (proxy) fullArgs.push('--proxy', proxy);
        fullArgs.push(...args);
        execFile(ytDlpPath, fullArgs, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

// Write cookies if provided (for extra safety)
if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
}

// ---------- Cobalt fallback ----------
async function tryCobalt(url) {
    try {
        const body = JSON.stringify({ url, filenamePattern: 'basic', videoQuality: '720' });
        const resp = await fetch('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body,
        });
        const data = await resp.json();
        if (data.url) {
            let title = 'YouTube Video', thumbnail = '';
            const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (idMatch) {
                thumbnail = `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
                try {
                    const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
                    if (oembed.ok) {
                        const o = await oembed.json();
                        title = o.title;
                        thumbnail = o.thumbnail_url || thumbnail;
                    }
                } catch (e) {}
            }
            return { title, thumbnail, downloadUrl: data.url };
        }
    } catch (e) { /* fall through */ }
    return null;
}

// ---------- YouTube endpoint (proxy rotator) ----------
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Try a sequence of proxies (up to 5 attempts)
    for (let attempt = 0; attempt < 5; attempt++) {
        const proxy = getNextProxy();
        if (!proxy) break;
        console.log(`Trying proxy ${attempt + 1}: ${proxy}`);
        try {
            // Use yt-dlp with proxy to get video info + direct URL
            const json = await ytDlp(['--dump-json', '--no-playlist', url], proxy);
            const info = JSON.parse(json);
            const format = (info.formats || []).filter(f => f.acodec !== 'none' && f.vcodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
            if (format) {
                const directUrl = await ytDlp(['-f', format.format_id, '-g', url], proxy);
                return res.json({ title: info.title, thumbnail: info.thumbnail, downloadUrl: directUrl });
            }
        } catch (e) {
            console.warn(`Proxy ${proxy} failed:`, e.message);
        }
    }

    // If all proxies fail, try Cobalt as last resort
    const cobalt = await tryCobalt(url);
    if (cobalt) return res.json(cobalt);

    res.status(500).json({ error: 'All YouTube extraction methods exhausted. Please try again later.' });
});

// ---------- TikTok (unchanged) ----------
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikTok API error');
        const v = data.data;
        const directUrl = v.hdplay || v.play || v.wmplay;
        if (!directUrl) throw new Error('No video URL');
        res.json({
            title: v.title || 'TikTok Video',
            thumbnail: v.cover || '',
            duration: v.duration || 'Unknown',
            author: v.author?.nickname || '',
            downloadUrl: directUrl,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Facebook / general (unchanged) ----------
const cache = new Map();
app.get('/api/info', async (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const json = await ytDlp(['--dump-json', '--no-playlist', url]);
        const info = JSON.parse(json);
        let formatId = 'best';
        if (format === 'mp3') {
            const bestAudio = (info.formats || []).filter(f => f.acodec !== 'none' && f.vcodec === 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
            if (bestAudio) formatId = bestAudio.format_id;
        } else {
            const combined = (info.formats || []).filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            if (combined.length) formatId = combined[0].format_id;
        }
        res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration_string, formatId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download', async (req, res) => {
    const { url, formatId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const key = `${url}|${formatId||'best'}`;
    if (cache.has(key) && Date.now() - cache.get(key).ts < 10*60*1000) {
        return res.json({ downloadUrl: cache.get(key).url });
    }
    try {
        const directUrl = await ytDlp(['-f', formatId || 'best', '-g', '--no-playlist', url]);
        cache.set(key, { url: directUrl, ts: Date.now() });
        res.json({ downloadUrl: directUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Proxy download (forces file save) ----------
app.get('/api/proxy-download', async (req, res) => {
    const { url, title, ext } = req.query;
    if (!url) return res.status(400).send('Missing URL');
    try {
        const videoResp = await fetch(url);
        if (!videoResp.ok) throw new Error(`CDN returned ${videoResp.status}`);
        const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', videoResp.headers.get('content-type') || 'video/mp4');
        videoResp.body.pipe(res);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));