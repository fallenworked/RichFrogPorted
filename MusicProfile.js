// @name NowPlayingBio
// @version 2.1.0
// @author @mvdddvv
// @description Меняет био профиля на текущую песню из Spotify или Last.fm
// @permissions account.modify,network.client,network.server,background,settings,storage

(function () {
    "use strict";

    var POLL_SECONDS = 60;
    var MIN_UPDATE_GAP = 300;
    var TOKEN_REFRESH_GAP = 50 * 60 * 1000;
    var OAUTH_PORT = 8888;
    var OAUTH_REDIRECT = "http://127.0.0.1:8888/callback";

    var S = {
        lastTrack: "",
        lastUpdateTs: 0,
        lastRefreshTs: 0,
        oauthServer: null,
        oauthVerifier: "",
        oauthState: ""
    };

    function log(t)   { try { wg.log.write("info", "npb", String(t)); } catch (_) {} }
    function toast(t) { try { wg.ui.toast(String(t)); } catch (_) {} }
    function get(k, d) { try { var v = wg.kv.get(k); return v === null || v === undefined ? d : v; } catch (_) { return d; } }
    function set(k, v) { try { wg.kv.set(k, v); } catch (e) { log("set " + k + ": " + e); } }
    function truthy(v) { return v === true || v === "true" || v === 1 || v === "1"; }

    // ---------- крипто для PKCE ----------
    function randomString(len) {
        var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        var bytes = wg.crypto.randomBytes(len);
        var s = "";
        for (var i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
        return s;
    }
    function base64url(bytes) {
        return String(wg.crypto.base64Encode(bytes, { urlSafe: true })).replace(/=+$/, "");
    }
    function sha256Bytes(str) {
        var b = [];
        for (var i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 0xff);
        return wg.crypto.hash("sha256", wg.bytes.from(b));
    }

    // ---------- Spotify OAuth ----------
    function startOAuth() {
        try {
            var clientId = String(get("spotify_client_id", "") || "");
            if (!clientId) { toast("Сначала введите Spotify Client ID"); return; }

            S.oauthVerifier = randomString(64);
            S.oauthState    = randomString(16);
            var challenge = base64url(sha256Bytes(S.oauthVerifier));

            var scope = "user-read-currently-playing user-read-playback-state";
            var authUrl = "https://accounts.spotify.com/authorize" +
                "?client_id=" + encodeURIComponent(clientId) +
                "&response_type=code" +
                "&redirect_uri=" + encodeURIComponent(OAUTH_REDIRECT) +
                "&code_challenge_method=S256" +
                "&code_challenge=" + challenge +
                "&state=" + S.oauthState +
                "&scope=" + encodeURIComponent(scope);

            log("oauth starting, port=" + OAUTH_PORT);
            var p = wg.server.start(OAUTH_PORT, {});
            if (p && typeof p.then === "function") {
                p.then(function (info) {
                    log("server started: " + JSON.stringify(info));
                    S.oauthServer = info;
                    try { wg.system.openURL(authUrl); toast("Войди в Spotify и вернись"); }
                    catch (e) {
                        wg.system.clipboardSet(authUrl);
                        toast("Ссылка скопирована в буфер — открой вручную");
                    }
                }).catch(function (e) {
                    log("server.start failed: " + e);
                    toast("Не удалось поднять сервер: " + e);
                });
            } else {
                S.oauthServer = p;
                wg.system.openURL(authUrl);
            }
        } catch (e) {
            log("startOAuth: " + e);
            toast("Ошибка OAuth: " + e);
        }
    }

    function stopOAuthServer() {
        try { wg.server.stop(); } catch (_) {}
        S.oauthServer = null;
    }

    function handleServerRequest(req) {
        try {
            var url = String((req && (req.path || req.url)) || "");
            log("server req: " + url);
            var qIdx = url.indexOf("?");
            if (qIdx < 0) { respondHtml(req, "Ждём..."); return; }
            var params = {};
            url.slice(qIdx + 1).split("&").forEach(function (kv) {
                var eq = kv.indexOf("=");
                var k = eq >= 0 ? kv.slice(0, eq) : kv;
                var v = eq >= 0 ? decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, " ")) : "";
                params[k] = v;
            });
            if (params.error) {
                respondHtml(req, "Ошибка Spotify: " + params.error);
                stopOAuthServer();
                return;
            }
            if (!params.code) { respondHtml(req, "Ждём код..."); return; }
            if (params.state !== S.oauthState) {
                respondHtml(req, "Неверный state");
                stopOAuthServer();
                return;
            }
            respondHtml(req, "✅ Готово. Закрой вкладку и вернись в WhiteGram.");
            exchangeCode(params.code);
            stopOAuthServer();
        } catch (e) {
            log("handleServerRequest: " + e);
        }
    }

    function respondHtml(req, text) {
        var html = "<!doctype html><meta charset='utf-8'>" +
            "<meta name='viewport' content='width=device-width'>" +
            "<style>body{font-family:-apple-system;background:#111;color:#eee;padding:40px;text-align:center}</style>" +
            "<h2>NowPlayingBio</h2><p>" + text + "</p>";
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
            "&code_verifier=" + encodeURIComponent(S.oauthVerifier);

        var p = wg.net.fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body
        });
        if (!p || typeof p.then !== "function") { log("fetch not promise"); return; }
        p.then(function (r) {
            try {
                var data = JSON.parse(r.body);
                if (data.access_token) {
                    set("spotify_token",   data.access_token);
                    set("spotify_refresh", data.refresh_token || "");
                    set("spotify_expires", String(Date.now() + (data.expires_in || 3600) * 1000));
                    S.lastRefreshTs = Date.now();
                    toast("Spotify подключён ✅");
                } else {
                    toast("Ошибка: " + (data.error_description || data.error || "?"));
                }
            } catch (e) { log("exchange parse: " + e); }
        }).catch(function (e) { log("exchange fetch: " + e); toast("Сеть: " + e); });
    }

    function refreshToken(cb) {
        try {
            var clientId = String(get("spotify_client_id", "") || "");
            var refresh  = String(get("spotify_refresh", "") || "");
            if (!clientId || !refresh) { cb && cb(false); return; }
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
                        S.lastRefreshTs = Date.now();
                        cb && cb(true);
                    } else cb && cb(false);
                } catch (_) { cb && cb(false); }
            }).catch(function () { cb && cb(false); });
        } catch (e) { log("refresh: " + e); cb && cb(false); }
    }

    // ---------- получение трека ----------
    function fetchSpotify(cb) {
        try {
            var token = String(get("spotify_token", "") || "");
            if (!token) { cb(null); return; }
            wg.net.fetch("https://api.spotify.com/v1/me/player/currently-playing", {
                method: "GET",
                headers: { "Authorization": "Bearer " + token }
            }).then(function (r) {
                if (r.status === 401) { refreshToken(function (ok) { ok ? fetchSpotify(cb) : cb(null); }); return; }
                try {
                    if (r.status !== 200 || !r.body) { cb(null); return; }
                    var d = JSON.parse(r.body);
                    if (!d || !d.item || !d.is_playing) { cb(null); return; }
                    cb({
                        artist: d.item.artists.map(function (a) { return a.name; }).join(", "),
                        title: d.item.name
                    });
                } catch (_) { cb(null); }
            }).catch(function () { cb(null); });
        } catch (e) { log("fetchSpotify: " + e); cb(null); }
    }

    function fetchLastfm(cb) {
        try {
            var apiKey = String(get("lastfm_api", "") || "");
            var user   = String(get("lastfm_user", "") || "");
            if (!apiKey || !user) { cb(null); return; }
            var url = "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks" +
                      "&user=" + encodeURIComponent(user) +
                      "&api_key=" + encodeURIComponent(apiKey) +
                      "&format=json&limit=1";
            wg.net.fetch(url, { method: "GET" }).then(function (r) {
                try {
                    var d = JSON.parse(r.body);
                    var t = d.recenttracks && d.recenttracks.track;
                    if (!t || !t.length) { cb(null); return; }
                    t = Array.isArray(t) ? t[0] : t;
                    if (!(t["@attr"] && t["@attr"].nowplaying === "true")) { cb(null); return; }
                    cb({ artist: t.artist["#text"], title: t.name });
                } catch (_) { cb(null); }
            }).catch(function () { cb(null); });
        } catch (e) { log("fetchLastfm: " + e); cb(null); }
    }

    function applyTrack(track) {
        if (!track) return;
        var key = track.artist + " — " + track.title;
        var now = Date.now();
        if (key === S.lastTrack) return;
        if (now - S.lastUpdateTs < MIN_UPDATE_GAP * 1000) return;
        S.lastTrack = key;
        S.lastUpdateTs = now;

        var tpl = String(get("template", "🎵 {artist} — {title}"));
        var bio = tpl.replace("{artist}", track.artist).replace("{title}", track.title);
        if (bio.length > 70) bio = bio.slice(0, 70);
        try {
            wg.tg.invoke("account.updateProfile", { about: bio }).then(function () {
                log("bio → " + bio);
            }).catch(function (e) { log("bio update: " + e); });
        } catch (e) { log("invoke: " + e); }
    }

    function poll() {
        try {
            if (!truthy(get("enabled", "true"))) return;
            var svc = String(get("service", "spotify")).toLowerCase();
            if (svc === "spotify") fetchSpotify(applyTrack);
            else if (svc === "lastfm") fetchLastfm(applyTrack);
        } catch (e) { log("poll: " + e); }
    }

    // ---------- безопасный биндер настройки ----------
    function bindSetting(hookName, key, transform) {
        try {
            wg.events.on(hookName, function (e) {
                try {
                    var v = (e && typeof e === "object" && ("value" in e)) ? e.value : e;
                    set(key, transform ? transform(v) : v);
                    log("set " + key + " = " + v);
                } catch (err) { log("handler " + key + ": " + err); }
            });
        } catch (err) { log("on " + hookName + ": " + err); }
    }

    // ---------- настройки ----------
    function registerSettings() {
        try {
            wg.screens.registerSettingsPage({
                id: "npb",
                title: "NowPlayingBio",
                controls: [
                    { id: "enabled",           type: "switch", title: "Включено",                  default: true,                     hookName: "npb_enabled" },
                    { id: "template",          type: "text",   title: "Формат",                    default: "🎵 {artist} — {title}",  hookName: "npb_template" },
                    { id: "service",           type: "text",   title: "Сервис (spotify | lastfm)", default: "spotify",                hookName: "npb_service" },
                    { id: "spotify_client_id", type: "text",   title: "Spotify Client ID",         default: "",                       hookName: "npb_sp_cid" },
                    { id: "sp_auth",           type: "button", title: "Войти в Spotify",                                              hookName: "npb_sp_auth" },
                    { id: "lastfm_api",        type: "text",   title: "Last.fm API key",           default: "",                       hookName: "npb_lf_api" },
                    { id: "lastfm_user",       type: "text",   title: "Last.fm Username",          default: "",                       hookName: "npb_lf_user" }
                ]
            });
            bindSetting("npb_enabled",  "enabled");
            bindSetting("npb_template", "template");
            bindSetting("npb_service",  "service",  function (v) { return String(v || "").trim().toLowerCase(); });
            bindSetting("npb_sp_cid",   "spotify_client_id");
            bindSetting("npb_lf_api",   "lastfm_api");
            bindSetting("npb_lf_user",  "lastfm_user");

            try {
                wg.events.on("npb_sp_auth", function () {
                    try { startOAuth(); } catch (e) { log("sp_auth: " + e); toast("Ошибка: " + e); }
                });
            } catch (e) { log("on npb_sp_auth: " + e); }
        } catch (e) { log("registerSettings: " + e); }
    }

    // ---------- команда .npb ----------
    function handleSend(msg) {
        try {
            var text = (msg && msg.text || "").trim();
            if (!text || text[0] !== ".") return wg.HookResult.continue();

            if (text === ".npb") {
                var info =
                    "Включено: " + (truthy(get("enabled", "true")) ? "да" : "нет") + "\n" +
                    "Сервис: " + get("service", "spotify") + "\n" +
                    "Spotify token: " + (get("spotify_token", "") ? "есть" : "нет") + "\n" +
                    "Spotify refresh: " + (get("spotify_refresh", "") ? "есть" : "нет") + "\n" +
                    "Last.fm key: " + (get("lastfm_api", "") ? "есть" : "нет") + "\n" +
                    "Last.fm user: " + (get("lastfm_user", "") || "—") + "\n" +
                    "Трек: " + (S.lastTrack || "—");
                wg.ui.actionSheet("NowPlayingBio", info, ["Обновить", "Открыть настройки", "Закрыть"], function (i) {
                    if (i === 0) poll();
                    else if (i === 1) { try { wg.screens.openSettingsPage("npb"); } catch (_) {} }
                });
                return wg.HookResult.cancel("npb");
            }
            if (text === ".npb auth") {
                startOAuth();
                return wg.HookResult.cancel("npb auth");
            }
            if (text === ".npb spotify") { set("service", "spotify"); toast("Сервис: Spotify"); return wg.HookResult.cancel("npb"); }
            if (text === ".npb lastfm")  { set("service", "lastfm");  toast("Сервис: Last.fm"); return wg.HookResult.cancel("npb"); }
            if (text === ".npb off")     { set("enabled", false);     toast("Выключено");       return wg.HookResult.cancel("npb"); }
            if (text === ".npb on")      { set("enabled", true);      toast("Включено");        return wg.HookResult.cancel("npb"); }

            return wg.HookResult.continue();
        } catch (e) { log("handleSend: " + e); return wg.HookResult.continue(); }
    }

    // ---------- init ----------
    function init() {
        log("init start");
        registerSettings();
        try { wg.intercept("message.beforeSend", handleSend, { priority: 10 }); }
        catch (e) { log("intercept: " + e); }
        try { wg.events.on("server.request", handleServerRequest); }
        catch (e) { log("server hook: " + e); }

        try {
            wg.scheduler.repeating(POLL_SECONDS, "npb_poll", {});
            wg.jobs.on("npb_poll", function () {
                try {
                    poll();
                    if (Date.now() - S.lastRefreshTs > TOKEN_REFRESH_GAP) {
                        if (get("spotify_refresh", "")) refreshToken(function () {});
                    }
                } catch (e) { log("job: " + e); }
            });
        } catch (e) { log("scheduler: " + e); }

        try {
            var exp = parseInt(get("spotify_expires", "0"), 10) || 0;
            if (exp && exp < Date.now() && get("spotify_refresh", "")) refreshToken(function () {});
        } catch (_) {}

        toast("NowPlayingBio готов. Открой настройки или напиши .npb");
        log("init done");
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
