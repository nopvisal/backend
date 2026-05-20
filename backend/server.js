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

// ---------- yt-dlp helper (your enhanced version) ----------
function ytDlp(args, proxy = null) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--no-warnings',
            '--no-playlist',
            '--socket-timeout', '15',
            '--user-agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            '--extractor-args',
            'youtube:player_client=android',
        ];

        if (fs.existsSync('./cookies.txt')) {
            fullArgs.push('--cookies', './cookies.txt');
        }

        if (proxy) {
            fullArgs.push('--proxy', proxy);
        }

        if (process.env.YTDLP_PROXY) {
            fullArgs.push('--proxy', process.env.YTDLP_PROXY);
        }

        fullArgs.push(...args);

        execFile(
            ytDlpPath,
            fullArgs,
            {
                timeout: 30000,
                maxBuffer: 15 * 1024 * 1024,
            },
            (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error(stderr || err.message || 'yt-dlp failed'));
                }
                resolve(stdout.trim());
            }
        );
    });
}

// Write cookies if present
if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
}

// ---------- Fetch with timeout ----------
function fetchWithTimeout(url, options = {}, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(url, { ...options, signal: controller.signal })
            .then(res => { clearTimeout(timer); resolve(res); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

// ---------- Proxy Rotator ----------
let proxyList = [];
let proxyIndex = 0;
let lastProxyFetch = 0;

async function fetchProxyList() {
    if (Date.now() - lastProxyFetch < 10 * 60 * 1000) return;
    lastProxyFetch = Date.now();
    return new Promise((resolve) => {
        const req = https.get('https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.data && parsed.data.length > 0) {
                        proxyList = parsed.data.map(p => `http://${p.ip}:${p.port}`);
                        proxyIndex = 0;
                        console.log(`Loaded ${proxyList.length} fresh proxies`);
                    }
                } catch (e) { console.warn('Proxy parse error'); }
                resolve();
            });
        });
        req.on('error', (e) => { console.warn('Proxy list fetch error:', e.message); resolve(); });
        req.setTimeout(5000, () => { req.destroy(); resolve(); });
    });
}

function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[proxyIndex % proxyList.length];
    proxyIndex++;
    return proxy;
}

fetchProxyList();
setInterval(fetchProxyList, 10 * 60 * 1000);

// ---------- YouTube fallbacks ----------
async function tryLucasDev(url) {
    try {
        const apiUrl = `https://api.lucash.dev/video?url=${encodeURIComponent(url)}`;
        const resp = await fetchWithTimeout(apiUrl);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.error || !data.download_url) return null;
        return { title: data.title || 'YouTube Video', thumbnail: data.thumbnail || '', downloadUrl: data.download_url };
    } catch (e) { return null; }
}

const invidiousInstances = [
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://vid.puffyan.us'
];

async function tryInvidious(videoId) {
    for (const instance of invidiousInstances) {
        try {
            const url = `${instance}/api/v1/videos/${videoId}`;
            const resp = await fetchWithTimeout(url);
            if (!resp.ok) continue;
            const data = await resp.json();
            const format = data.formatStreams
                ?.filter(f => f.container === 'mp4' && f.audioChannels > 0)
                ?.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            if (format) {
                return { title: data.title, thumbnail: data.videoThumbnails?.[0]?.url || '', downloadUrl: format.url };
            }
        } catch (e) { /* next */ }
    }
    return null;
}

async function tryCobalt(url) {
    try {
        const body = JSON.stringify({ url, filenamePattern: 'basic', videoQuality: '720' });
        const resp = await fetchWithTimeout('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body,
        });
        const data = await resp.json();
        if (!data.url) return null;
        let title = 'YouTube Video', thumbnail = '';
        const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        if (idMatch) {
            thumbnail = `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
            try {
                const oembed = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
                if (oembed.ok) {
                    const o = await oembed.json();
                    title = o.title; thumbnail = o.thumbnail_url || thumbnail;
                }
            } catch (e) {}
        }
        return { title, thumbnail, downloadUrl: data.url };
    } catch (e) { return null; }
}

// ---------- YouTube endpoint ----------
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // 1. Direct yt-dlp first (with your enhanced settings)
    try {
        console.log('Trying direct yt-dlp...');
        const json = await ytDlp(['--dump-single-json', url]);
        const info = JSON.parse(json);
        const formats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (formats.length > 0) {
            const directUrl = await ytDlp(['-f', formats[0].format_id, '-g', url]);
            return res.json({
                title: info.title,
                thumbnail: info.thumbnail,
                duration: info.duration_string,
                quality: formats[0].height ? `${formats[0].height}p` : 'Unknown',
                downloadUrl: directUrl,
            });
        }
    } catch (e) {
        console.warn('Direct yt-dlp failed:', e.message);
    }

    // 2. Rotating free proxies
    for (let attempt = 0; attempt < 3; attempt++) {
        const proxy = getNextProxy();
        if (!proxy) break;
        try {
            console.log(`Trying proxy ${attempt + 1}: ${proxy}`);
            const json = await ytDlp(['--dump-single-json', url], proxy);
            const info = JSON.parse(json);
            const formats = (info.formats || [])
                .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            if (formats.length > 0) {
                const directUrl = await ytDlp(['-f', formats[0].format_id, '-g', url], proxy);
                return res.json({
                    title: info.title,
                    thumbnail: info.thumbnail,
                    duration: info.duration_string,
                    quality: formats[0].height ? `${formats[0].height}p` : 'Unknown',
                    downloadUrl: directUrl,
                });
            }
        } catch (e) {
            console.warn(`Proxy failed: ${proxy}`);
        }
    }

    // 3. LucasDev
    const lucas = await tryLucasDev(url);
    if (lucas) return res.json(lucas);

    // 4. Invidious
    const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (idMatch) {
        const invidious = await tryInvidious(idMatch[1]);
        if (invidious) return res.json(invidious);
    }

    // 5. Cobalt
    const cobalt = await tryCobalt(url);
    if (cobalt) return res.json(cobalt);

    res.status(500).json({ error: 'All YouTube extraction methods failed. Please try again later.' });
});

// ---------- TikTok ----------
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const resp = await fetchWithTimeout(apiUrl);
        const data = await resp.json();
        if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikTok API error');
        const v = data.data;
        const directUrl = v.hdplay || v.play || v.wmplay;
        if (!directUrl) throw new Error('No video URL');
        res.json({
            title: v.title || 'TikTok Video', thumbnail: v.cover || '',
            duration: v.duration || 'Unknown', author: v.author?.nickname || '', downloadUrl: directUrl,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Facebook / general (yt-dlp) ----------
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

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));