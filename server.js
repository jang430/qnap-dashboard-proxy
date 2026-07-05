require('dotenv').config();
const express = require('express');
const axios = require('axios');
const snmp = require('net-snmp');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 15 }); // 15s cache so the ESP32 can poll often without hammering everything

// ─────────────────────────────────────────────────────────────────
// SNMP v3 setup (QNAP TS-873a) — authNoPriv / HMAC-MD5, per NAS config
// ─────────────────────────────────────────────────────────────────
const authProtocolMap = { MD5: snmp.AuthProtocols.md5, SHA: snmp.AuthProtocols.sha };

const snmpUser = {
  name: process.env.QNAP_SNMP_USER,
  level: snmp.SecurityLevel.authNoPriv, // "Enable privacy" is unchecked on the NAS
  authProtocol: authProtocolMap[process.env.QNAP_SNMP_AUTH_PROTOCOL] || snmp.AuthProtocols.md5,
  authKey: process.env.QNAP_SNMP_AUTH_PASSWORD,
};

function getSnmpSession() {
  return snmp.createV3Session(process.env.QNAP_HOST, snmpUser, { port: 161, retries: 1, timeout: 5000 });
}

function snmpGet(oids) {
  return new Promise((resolve, reject) => {
    const session = getSnmpSession();
    session.get(oids, (error, varbinds) => {
      session.close();
      if (error) return reject(error);
      resolve(varbinds);
    });
  });
}

function snmpWalk(oid) {
  return new Promise((resolve, reject) => {
    const session = getSnmpSession();
    const results = [];
    session.subtree(
      oid,
      (varbinds) => {
        varbinds.forEach((vb) => {
          if (!snmp.isVarbindError(vb)) results.push(vb);
        });
      },
      (error) => {
        session.close();
        if (error) return reject(error);
        resolve(results);
      }
    );
  });
}

function varbindValue(vb) {
  if (!vb) return null;
  const val = vb.value;
  return Buffer.isBuffer(val) ? val.toString() : val;
}

// QNAP QuTS hero private MIB OIDs — taken directly from the NAS's own
// downloaded NAS.mib (enterprise 55062, module rev 2.0). These are exact,
// not reverse-engineered guesses: qnap=55062, qutshero={qnap 2}=55062.2,
// storage={qutshero 10}=55062.2.10, system={qutshero 12}=55062.2.12
const BASE = '1.3.6.1.4.1.55062.2';
const OID = {
  // system group (55062.2.12.*) — all plain Integer32/Counter64, no string parsing needed
  systemModel: `${BASE}.12.3.0`,
  hostname: `${BASE}.12.4.0`,
  firmwareVersion: `${BASE}.12.6.0`,
  cpuTemp: `${BASE}.12.10.0`, // Integer32, degrees C
  systemTemp: `${BASE}.12.11.0`, // Integer32, degrees C
  cpuUsage: `${BASE}.12.12.0`, // Integer32, percent
  totalMem: `${BASE}.12.13.0`, // Counter64
  freeMem: `${BASE}.12.14.0`, // Counter64
  availableMem: `${BASE}.12.15.0`, // Counter64
  usedMem: `${BASE}.12.16.0`, // Counter64
  powerStatus: `${BASE}.12.19.0`, // -1 failed, 0 ok
  sysUptime: `${BASE}.12.21.0`, // TimeTicks
  sysFanNumber: `${BASE}.12.8.0`,
  sysFanTable: `${BASE}.12.9.1`, // columns: 1=index, 2=descr, 3=speed

  // storage group (55062.2.10.*)
  diskCount: `${BASE}.10.1.0`,
  diskTable: `${BASE}.10.2.1`, // columns: 1=index,2=id,3=mfr,4=model,5=serial,6=type,7=status,8=temp(Integer32 C),9=capacity(bytes)
  storagepoolCount: `${BASE}.10.6.0`,
  storagepoolTable: `${BASE}.10.7.1`, // columns: 1=index,2=id,3=capacity(bytes),4=freeSize(bytes),5=status
};

// ─────────────────────────────────────────────────────────────────
// QNAP endpoints
// ─────────────────────────────────────────────────────────────────
app.get('/api/qnap/system', async (req, res) => {
  const cached = cache.get('qnap-system');
  if (cached) return res.json(cached);

  try {
    const vbs = await snmpGet([
      OID.cpuTemp,
      OID.systemTemp,
      OID.cpuUsage,
      OID.totalMem,
      OID.freeMem,
      OID.usedMem,
      OID.powerStatus,
      OID.sysUptime,
    ]);

    const totalMemBytes = Number(vbs[3].value);
    const usedMemBytes = Number(vbs[5].value);

    const result = {
      cpuTempC: Number(vbs[0].value),
      systemTempC: Number(vbs[1].value),
      cpuUsagePercent: Number(vbs[2].value),
      totalMemGB: +(totalMemBytes / 1e9).toFixed(1),
      freeMemGB: +(Number(vbs[4].value) / 1e9).toFixed(1),
      usedMemGB: +(usedMemBytes / 1e9).toFixed(1),
      usedMemPercent: totalMemBytes ? Math.round((usedMemBytes / totalMemBytes) * 100) : null,
      powerOk: Number(vbs[6].value) === 0,
      uptimeTicks: Number(vbs[7].value), // divide by 8640000 for days
      fetchedAt: new Date().toISOString(),
    };
    cache.set('qnap-system', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'snmp_failed', message: err.message });
  }
});

// storagepoolStatus per NAS.mib: -3 error, -2 notReady, -1 warning, 0 ready
// (QuTS hero also documents -6 SED_LOCKED, -5 DETACHING, -4 REMOVING)
const POOL_STATUS_LABELS = {
  0: 'ready', '-1': 'warning', '-2': 'notReady', '-3': 'error', '-4': 'removing', '-5': 'detaching', '-6': 'sedLocked',
};

app.get('/api/qnap/storage', async (req, res) => {
  const cached = cache.get('qnap-storage');
  if (cached) return res.json(cached);

  try {
    const rows = await snmpWalk(OID.storagepoolTable);
    // Columns per NAS.mib: 1=index, 2=id, 3=capacity(bytes), 4=freeSize(bytes), 5=status
    const byIndex = {};
    rows.forEach((vb) => {
      const parts = vb.oid.split('.');
      const column = parts[parts.length - 2];
      const index = parts[parts.length - 1];
      byIndex[index] = byIndex[index] || {};
      if (column === '2') byIndex[index].id = Number(vb.value);
      if (column === '3') byIndex[index].capacity = Number(vb.value);
      if (column === '4') byIndex[index].freeSize = Number(vb.value);
      if (column === '5') byIndex[index].status = Number(vb.value);
    });

    const pools = Object.values(byIndex)
      .filter((p) => p.capacity > 0)
      .map((p) => {
        const usedBytes = p.capacity - p.freeSize;
        return {
          poolId: p.id,
          sizeGB: +(p.capacity / 1e9).toFixed(1),
          freeGB: +(p.freeSize / 1e9).toFixed(1),
          usedGB: +(usedBytes / 1e9).toFixed(1),
          usedPercent: Math.round((usedBytes / p.capacity) * 100),
          status: POOL_STATUS_LABELS[p.status] || `unknown(${p.status})`,
        };
      });

    const result = { pools, fetchedAt: new Date().toISOString() };
    cache.set('qnap-storage', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'snmp_failed', message: err.message });
  }
});

app.get('/api/qnap/disks', async (req, res) => {
  const cached = cache.get('qnap-disks');
  if (cached) return res.json(cached);

  try {
    const rows = await snmpWalk(OID.diskTable);
    // Columns per NAS.mib: 1=index,2=id,3=mfr,4=model,5=serial,6=type,7=status,8=temp(C),9=capacity(bytes)
    const byIndex = {};
    rows.forEach((vb) => {
      const parts = vb.oid.split('.');
      const column = parts[parts.length - 2];
      const index = parts[parts.length - 1];
      byIndex[index] = byIndex[index] || {};
      if (column === '3') byIndex[index].manufacturer = varbindValue(vb);
      if (column === '4') byIndex[index].model = varbindValue(vb);
      if (column === '6') byIndex[index].type = varbindValue(vb);
      if (column === '7') byIndex[index].status = varbindValue(vb);
      if (column === '8') byIndex[index].tempC = Number(vb.value);
      if (column === '9') byIndex[index].capacityBytes = Number(vb.value);
    });

    const disks = Object.entries(byIndex).map(([index, d]) => ({
      bay: Number(index),
      manufacturer: d.manufacturer,
      model: d.model,
      type: d.type,
      status: d.status,
      tempC: d.tempC,
      capacityGB: d.capacityBytes ? +(d.capacityBytes / 1e9).toFixed(0) : null,
    }));

    const result = { disks, fetchedAt: new Date().toISOString() };
    cache.set('qnap-disks', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'snmp_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Sonarr — recently added episodes
// ─────────────────────────────────────────────────────────────────
app.get('/api/sonarr/recent', async (req, res) => {
  const cached = cache.get('sonarr-recent');
  if (cached) return res.json(cached);

  try {
    const url = `http://${process.env.SONARR_HOST}:${process.env.SONARR_PORT}/api/v3/history`;
    const { data } = await axios.get(url, {
      params: {
        page: 1,
        pageSize: 10,
        sortKey: 'date',
        sortDirection: 'descending',
        eventType: 'downloadFolderImported',
        includeSeries: true,
        includeEpisode: true,
      },
      headers: { 'X-Api-Key': process.env.SONARR_API_KEY },
    });

    const items = data.records.map((r) => ({
      series: r.series?.title,
      episode: r.episode ? `S${String(r.episode.seasonNumber).padStart(2, '0')}E${String(r.episode.episodeNumber).padStart(2, '0')} — ${r.episode.title}` : null,
      date: r.date,
    }));
    const result = { items, fetchedAt: new Date().toISOString() };
    cache.set('sonarr-recent', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'sonarr_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Radarr — recently added movies
// ─────────────────────────────────────────────────────────────────
app.get('/api/radarr/recent', async (req, res) => {
  const cached = cache.get('radarr-recent');
  if (cached) return res.json(cached);

  try {
    const url = `http://${process.env.RADARR_HOST}:${process.env.RADARR_PORT}/api/v3/history`;
    const { data } = await axios.get(url, {
      params: {
        page: 1,
        pageSize: 10,
        sortKey: 'date',
        sortDirection: 'descending',
        eventType: 'downloadFolderImported',
        includeMovie: true,
      },
      headers: { 'X-Api-Key': process.env.RADARR_API_KEY },
    });

    const items = data.records.map((r) => ({
      movie: r.movie?.title,
      year: r.movie?.year,
      date: r.date,
    }));
    const result = { items, fetchedAt: new Date().toISOString() };
    cache.set('radarr-recent', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'radarr_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// SABnzbd — current queue
// ─────────────────────────────────────────────────────────────────
app.get('/api/sabnzbd/queue', async (req, res) => {
  const cached = cache.get('sabnzbd-queue');
  if (cached) return res.json(cached);

  try {
    const url = `http://${process.env.SABNZBD_HOST}:${process.env.SABNZBD_PORT}/api`;
    const { data } = await axios.get(url, {
      params: { mode: 'queue', output: 'json', apikey: process.env.SABNZBD_API_KEY },
    });

    const q = data.queue;
    const result = {
      speed: q.kbpersec ? `${(q.kbpersec / 1024).toFixed(1)} MB/s` : '0 MB/s',
      sizeLeft: q.sizeleft,
      timeLeft: q.timeleft,
      items: (q.slots || []).slice(0, 5).map((s) => ({ name: s.filename, percent: s.percentage, status: s.status })),
      fetchedAt: new Date().toISOString(),
    };
    cache.set('sabnzbd-queue', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'sabnzbd_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// qBittorrent — active torrents
// ─────────────────────────────────────────────────────────────────
async function qbitLogin() {
  const cachedCookie = cache.get('qbit-cookie');
  if (cachedCookie) return cachedCookie;

  const url = `http://${process.env.QBIT_HOST}:${process.env.QBIT_PORT}/api/v2/auth/login`;
  const params = new URLSearchParams();
  params.append('username', process.env.QBIT_USERNAME);
  params.append('password', process.env.QBIT_PASSWORD);

  const response = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
  if (!cookie) throw new Error('qBittorrent login did not return a session cookie');
  cache.set('qbit-cookie', cookie, 1800); // qBittorrent sessions last a while; refresh every 30 min
  return cookie;
}

app.get('/api/qbittorrent/torrents', async (req, res) => {
  const cached = cache.get('qbit-torrents');
  if (cached) return res.json(cached);

  try {
    const cookie = await qbitLogin();
    const url = `http://${process.env.QBIT_HOST}:${process.env.QBIT_PORT}/api/v2/torrents/info`;
    const { data } = await axios.get(url, { headers: { Cookie: cookie } });

    const items = data
      .filter((t) => t.state !== 'pausedUP' && t.state !== 'pausedDL')
      .slice(0, 10)
      .map((t) => ({
        name: t.name,
        progress: Math.round(t.progress * 100),
        dlSpeed: t.dlspeed,
        upSpeed: t.upspeed,
        state: t.state,
      }));
    const result = { items, fetchedAt: new Date().toISOString() };
    cache.set('qbit-torrents', result);
    res.json(result);
  } catch (err) {
    cache.del('qbit-cookie'); // force re-login next time in case session expired
    res.status(502).json({ error: 'qbittorrent_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Emby — now playing sessions (the headline widget)
// ─────────────────────────────────────────────────────────────────
app.get('/api/emby/nowplaying', async (req, res) => {
  const cached = cache.get('emby-nowplaying');
  if (cached) return res.json(cached);

  try {
    const url = `http://${process.env.EMBY_HOST}:${process.env.EMBY_PORT}/Sessions`;
    const { data } = await axios.get(url, { params: { api_key: process.env.EMBY_API_KEY } });

    const sessions = data
      .filter((s) => s.NowPlayingItem)
      .map((s) => ({
        user: s.UserName,
        device: s.DeviceName,
        title: s.NowPlayingItem.SeriesName
          ? `${s.NowPlayingItem.SeriesName} — ${s.NowPlayingItem.Name}`
          : s.NowPlayingItem.Name,
        type: s.NowPlayingItem.Type,
        progressPercent: s.PlayState?.PositionTicks && s.NowPlayingItem.RunTimeTicks
          ? Math.round((s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100)
          : null,
        paused: !!s.PlayState?.IsPaused,
      }));
    const result = { activeStreams: sessions.length, sessions, fetchedAt: new Date().toISOString() };
    cache.set('emby-nowplaying', result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'emby_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// TMDB — recently released movies/TV, formatted for a scrolling ticker
// ─────────────────────────────────────────────────────────────────
app.get('/api/tmdb/ticker', async (req, res) => {
  const cached = cache.get('tmdb-ticker');
  if (cached) return res.json(cached);

  try {
    const today = new Date().toISOString().split('T')[0];
    const [nowPlaying, recentUsShows] = await Promise.all([
      axios.get('https://api.themoviedb.org/3/movie/now_playing', {
        params: { api_key: process.env.TMDB_API_KEY, region: 'US', page: 1 },
      }),
      axios.get('https://api.themoviedb.org/3/discover/tv', {
        params: {
          api_key: process.env.TMDB_API_KEY,
          with_origin_country: 'US',
          sort_by: 'first_air_date.desc',
          'air_date.lte': today,
          page: 1,
        },
      }),
    ]);

    const movies = nowPlaying.data.results.slice(0, 8).map((m) => ({
      type: 'movie',
      title: m.title,
      date: m.release_date,
      rating: m.vote_average,
    }));

    const shows = recentUsShows.data.results.slice(0, 8).map((s) => ({
      type: 'tv',
      title: s.name,
      date: s.first_air_date,
      rating: s.vote_average,
    }));

    // Interleave movies/shows and build a single scrolling ticker string,
    // e.g. "🎬 New: Movie Title  •  📺 New: Show Title  •  ..."
    const items = [];
    const max = Math.max(movies.length, shows.length);
    for (let i = 0; i < max; i++) {
      if (movies[i]) items.push(movies[i]);
      if (shows[i]) items.push(shows[i]);
    }

    const tickerText = items
      .map((i) => `${i.type === 'movie' ? '🎬' : '📺'} ${i.title}`)
      .join('   •   ');

    const result = { items, tickerText, fetchedAt: new Date().toISOString() };
    cache.set('tmdb-ticker', result, 21600); // 6 hours — this content barely changes
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'tmdb_failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Combined summary — one call for the ESP32 to grab everything at once
// ─────────────────────────────────────────────────────────────────
app.get('/api/summary', async (req, res) => {
  const base = 'http://localhost:' + (process.env.PORT || 9999);
  const endpoints = [
    `${base}/api/emby/nowplaying`,
    `${base}/api/qnap/system`,
    `${base}/api/qnap/storage`,
    `${base}/api/tmdb/ticker`,
  ];
  try {
    const [emby, system, storage, tmdb] = await Promise.all(endpoints.map((u) => axios.get(u).then((r) => r.data).catch((e) => ({ error: e.message }))));
    res.json({ emby, system, storage, tmdb, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: 'summary_failed', message: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 9999;
app.listen(PORT, () => console.log(`QNAP dashboard proxy listening on port ${PORT}`));
