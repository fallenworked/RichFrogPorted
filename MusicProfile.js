// @name NowPlayingBio
// @version 2.0.0
// @author you
// @description Меняет био профиля на текущую песню из Spotify или Last.fm
// @permissions account.modify,network.client,network.server,background,settings,storage

(function () {
    "use strict";

    var POLL_SECONDS = 60;
    var MIN_UPDATE_GAP = 300;            // 5 минут между сменами био
    var TOKEN_REFRESH_GAP = 50 * 60 * 1000;
    var OAUTH_PORT = 8888;
    var OAUTH_REDIRECT = "http://127.0.0.1:8888/callback";

    var state = {
        lastTrack: "",
        lastUpdateTs: 0,
        lastRefreshTs: 0,
        oauthServer: null,
        oauthVerifier: "",
        oauthState: ""
    };

    function toast(t) { try { wg.ui.toast(String(t)); } catch (_) {} }
    function log(t)   { try { wg.log.write("info", "npb", String(t)); } catch (_) {} }
    function get(k, d) { try { var v = wg.kv.get(k); return v === null || v === undefined ? d : v; } catch (_) { return d; } }
    function set(k, v) { try { wg.kv.set(k, v); } catch (_) {} }
    function truthy(v) { return v === true || v === "true" || v === 1 || v === "1"; }

    // ---------- crypto ----------
    function randomString(len) {
        var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        var bytes = wg.crypto.randomBytes(len);
        var s = "";
        for (var i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
        return s;
    }
    function base64url(bytes) {
        var s = wg.crypto.base64Encode(bytes, { urlSafe: true });
        return String(s).replace(/=+$/, "");
    }
    function sha256Bytes(str) {
        var b = [];
        for (var i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 0xff);
        return wg.crypto.hash("sha256", wg.bytes.from(b));
    }

    // ---------- Spotify OAuth (PKCE) ----------
    function startOAuth() {
        var clientId = String(get("spotify_client_id", "") || "");
        if (!clientId) { toast("Сначала введите Client ID"); return; }

        state.oauthVerifier = randomString(64);
        state.oauthState    = randomString(16);
        var challenge = base64url(sha256Bytes(state.oauthVerifier));

        var scope = "user-read-currently-playing user-read-playback-state";
        var authUrl = "https://accounts.spotify.com/authorize" +
            "?client_id=" + encodeURIComponent(clientId) +
            "&response_type=code" +
            "&redirect_uri=" + encodeURIComponent(OAUTH_REDIRECT) +
            "&code_challenge_method=S256" +
            "&code_challenge=" + challenge +
            "&state=" + state.oauthState +
            "&scope=" + encodeURIComponent(scope);

        wg.server.start(OAUTH_PORT, {}).then(function (info) {
            state.oauthServer = info;
            toast("Открываю Safari. Войди в Spotify и вернись.");
            try { wg.system.openURL(authUrl); }
            catch (_) {
                wg.system.clipboardSet(authUrl);
                toast("Ссылка в буфере — открой вручную");
            }
        }).catch(function (e) {
            log("server start: " + e);
            toast("Порт 8888 занят: " + e);
        });
    }

    function stopOAuthServer() {
        if (!state.oauthServer) return;
        try { wg.server.stop(); } catch (_) {}
        state.oauthServer = null;
    }

    function handleServerRequest(req) {
        try {
            var url = String(req.path || req.url || "");
            var qIdx = url.indexOf("?");
            if (qIdx < 0) { respondHtml(req, "NowPlayingBio"); return; }
            var params = {};
            url.slice(qIdx + 1).split("&").forEach(function (kv) {
                var eq = kv.indexOf("=");
                var k = eq >= 0 ? kv.slice(0, eq) : kv;
                var v = eq >= 0 ? decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, " ")) : "";
                params[k] = v;
            });

            if (params.error) {
                respondHtml(req, "Ошибка: " + params.error);
                stopOAuthServer();
                return;
            }
            if (!params.code) { respondHtml(req, "Ждём…"); return; }
            if (params.state !== state.oauthState) {
                respondHtml(req, "Неверный state");
                stopOAuthServer();
                return;
            }
            respondHtml(req, "✅ Готово. Закрой вкладку и вернись в WhiteGram.");
            exchangeCode(params.code);
            stopOAuthServer();
        } catch (e) { log("server req: " + e); }
    }

    function respondHtml(req, text) {
        var html = "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width'>" +
            "<style>body{font-family:-apple-system;background:#111;color:#eee;padding:40px;text-align:center}" +
            "h2{margin-bottom:20px}</style><h2>NowPlayingBio</h2><p>" + text + "</p>";
        try {
            wg.server.respond(req.requestId, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
                body: html
            });
        } catch (e) { log("respond: " + e); }
    }

    function exchangeCode(code) {
        var clientId = String(get("spotify_client_id", "") || "");
        var body = "grant_type=authorization_code" +
            "&code=" + encodeURIComponent(code) +
            "&redirect_uri=" + encodeURIComponent(OAUTH_REDIRECT) +
            "&client_id=" + encodeURIComponent(clientId) +
            "&code_verifier=" + encodeURIComponent(state.oauthVerifier);

        wg.net.fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body
        }).then(function (r) {
            try {
                var data = JSON.parse(r.body);
                if (data.access_token) {
                    set("spotify_token",   data.access_token);
                    set("spotify_refresh", data.refresh_token || "");
                    set("spotify_expires", String(Date.now() + (data.expires_in || 3600) * 1000));
                    state.lastRefreshTs = Date.now();
                    toast("Spotify подключён ✅");
                    log("token saved");
                } else {
                    toast("Не удалось: " + (data.error_description || data.error || "?"));
                }
            } catch (e) { log("exchange parse: " + e); }
        }).catch(function (e) {
            log("exchange fetch: " + e);
            toast("Ошибка обмена: " + e);
        });
    }

    function refreshToken(cb) {
        var clientId = String(get("spotify_client_id", "") || "");
        var refresh  = String(get("spotify_refresh", "") || "");
        if (!clientId || !refresh) { cb(false); return; }
        var body = "grant_type=refresh_token" +
            "&refresh_token=" + encodeURIComponent(refresh) +
            "&client_id=" + encodeURIComponent(clientId);
        wg.net.fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body
        }).then(function (r) {
            try {
                var data = JSON.parse(r.body);
                if (data.access_token) {
                    set("spotify_token", data.access_token);
                    set("spotify_expires", String(Date.now() + (data.expires_in || 3600) * 1000));
                    if (data.refresh_token) set("spotify_refresh", data.refresh_token);
                    state.lastRefreshTs = Date.now();
                    cb(true);
                } else cb(false);
            } catch (_) { cb(false); }
        }).catch(function () { cb(false); });
    }

    // ---------- трек из сервисов ----------
    function fetchSpotify(cb) {
        var token = String(get("spotify_token", "") || "");
        if (!token) { cb(null); return; }
        wg.net.fetch("https://api.spotify.com/v1/me/player/currently-playing", {
            method: "GET",
            headers: { "Authorization": "Bearer " + token }
        }).then(function (r) {
            if (r.status === 401) { refreshToken(function (ok) { ok ? fetchSpotify(cb) : cb(null); }); return; }
            try {
                if (r.status !== 200) { cb(null); return; }
                var data = JSON.parse(r.body);
                if (!data || !data.item || !data.is_playing) { cb(null); return; }
                cb({
                    artist: data.item.artists.map(function (a) { return a.name; }).join(", "),
                    title: data.item.name
                });
            } catch (e) { log("sp parse: " + e); cb(null); }
        }).catch(function (e) { log("sp fetch: " + e); cb(null); });
    }

    function fetchLastfm(cb) {
        var apiKey = String(get("lastfm_api", "") || "");
        var user   = String(get("lastfm_user", "") || "");
        if (!apiKey || !user) { cb(null); return; }
        var url = "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks" +
                  "&user=" + encodeURIComponent(user) +
                  "&api_key=" + encodeURIComponent(apiKey) +
                  "&format=json&limit=1";
        wg.net.fetch(url, { method: "GET" }).then(function (r) {
            try {
                var data = JSON.parse(r.body);
                var tracks = data.recenttracks && data.recenttracks.track;
                if (!tracks || !tracks.length) { cb(null); return; }
                var t = Array.isArray(tracks) ? tracks[0] : tracks;
                if (!(t["@attr"] && t["@attr"].nowplaying === "true")) { cb(null); return; }
                cb({ artist: t.artist["#text"], title: t.name });
            } catch (_) { cb(null); }
        }).catch(function () { cb(null); });
    }

    // ---------- смена био ----------
    function applyTrack(track) {
        if (!track) return;
        var key = track.artist + " — " + track.title;
        var now = Date.now();
        if (key === state.lastTrack) return;
        if (now - state.lastUpdateTs < MIN_UPDATE_GAP * 1000) return;
        state.lastTrack = key;
        state.lastUpdateTs = now;

        var tpl = String(get("template", "🎵 {artist} — {title}"));
        var bio = tpl.replace("{artist}", track.artist).replace("{title}", track.title);
        if (bio.length > 70) bio = bio.slice(0, 70);
        wg.tg.invoke("account.updateProfile", { about: bio }).then(function () {
            log("bio → " + bio);
        }).catch(function (e) { log("bio update: " + e); });
    }

    function poll() {
        if (!truthy(get("enabled", "true"))) return;
        var svc = String(get("service", "spotify"));
        if (svc === "spotify") fetchSpotify(applyTrack);
        else if (svc === "lastfm") fetchLastfm(applyTrack);
    }

    // ---------- настройки ----------
    function registerSettings() {
        try {
            wg.screens.registerSettingsPage({
                id: "npb",
                title: "NowPlayingBio",
                controls: [
                    { id: "enabled",  type: "switch", title: "Включено", default: true, hookName: "npb:enabled" },
                    { id: "service",  type: "select", title: "Сервис", default: "spotify",
                      options: [
                          { title: "Spotify", value: "spotify" },
                          { title: "Last.fm", value: "lastfm" }
                      ], hookName: "npb:service" },
                    { id: "template", type: "text", title: "Формат", default: "🎵 {artist} — {title}", hookName: "npb:template" },

                    { id: "sec_sp", type: "section", title: "Spotify" },
                    { id: "spotify_client_id", type: "text", title: "Client ID", default: "", hookName: "npb:sp_cid" },
                    { id: "sp_oauth", type: "button", title: "Войти в Spotify", hookName: "npb:sp_auth" },

                    { id: "sec_lf", type: "section", title: "Last.fm" },
                    { id: "lastfm_api",  type: "text", title: "API key", default: "", hookName: "npb:lf_api" },
                    { id: "lastfm_user", type: "text", title: "Username", default: "", hookName: "npb:lf_user" }
                ]
            });

            wg.events.on("npb:enabled",  function (e) { set("enabled", e.value); });
            wg.events.on("npb:service",  function (e) { set("service", e.value); });
            wg.events.on("npb:template", function (e) { set("template", e.value); });
            wg.events.on("npb:sp_cid",   function (e) { set("spotify_client_id", e.value); });
            wg.events.on("npb:lf_api",   function (e) { set("lastfm_api", e.value); });
            wg.events.on("npb:lf_user",  function (e) { set("lastfm_user", e.value); });
            wg.events.on("npb:sp_auth",  function ()  { startOAuth(); });
        } catch (e) { log("settings: " + e); }
    }

    // ---------- команда .npb ----------
    function handleSend(msg) {
        var text = (msg && msg.text || "").trim();
        if (text !== ".npb") return wg.HookResult.continue();
        var info =
            "Состояние: " + (truthy(get("enabled", "true")) ? "вкл" : "выкл") + "\n" +
            "Сервис: " + get("service", "spotify") + "\n" +
            "Последний трек: " + (state.lastTrack || "—") + "\n" +
            "Spotify token: " + (get("spotify_token", "") ? "есть" : "нет");
        wg.ui.actionSheet("NowPlayingBio", info, ["Обновить сейчас", "Закрыть"], function (i) {
            if (i === 0) poll();
        });
        return wg.HookResult.cancel("npb");
    }

    // ---------- init ----------
    function init() {
        registerSettings();
        try { wg.intercept("message.beforeSend", handleSend, { priority: 10 }); } catch (e) { log("intercept: " + e); }
        try { wg.events.on("server.request", handleServerRequest); } catch (e) { log("server hook: " + e); }

        try { wg.scheduler.repeating(POLL_SECONDS, "npb_poll", {}); } catch (e) { log("sched: " + e); }
        try {
            wg.jobs.on("npb_poll", function () {
                poll();
                if (Date.now() - state.lastRefreshTs > TOKEN_REFRESH_GAP) {
                    if (get("spotify_refresh", "")) refreshToken(function () {});
                }
            });
        } catch (e) { log("jobs: " + e); }

        // фоновая задача на старте — обновить токен, если истёк
        try {
            var exp = parseInt(get("spotify_expires", "0"), 10) || 0;
            if (exp && exp < Date.now() && get("spotify_refresh", "")) refreshToken(function () {});
        } catch (_) {}

        toast("NowPlayingBio готов. Настройки → Плагины");
    }

    if (typeof wg.registerPlugin === "function" && typeof wg.BasePlugin === "function") {
        class NowPlayingBio extends wg.BasePlugin {
            onLoad() { init(); }
            onUnload() {
                try { wg.scheduler.cancel("npb_poll"); } catch (_) {}
                try { wg.server.stop(); } catch (_) {}
            }
        }
        wg.registerPlugin(new NowPlayingBio());
    } else {
        init();
    }
})();
