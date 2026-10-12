// @name RichFrog
// @version 2.0.0
// @author @Meapia
// @description Рейтинг, NFT-подарки, NFT-username и анонимный номер в профиле (видно только тебе)
// @permissions messages.read,messages.send,ui.inject,ui.modifyTelegram,storage,settings,notifications

(function () {
    "use strict";

    var MAX_LEVEL = 100;

    function levelThreshold(lv) {
        if (lv <= 1) return 0;
        return Math.round(9522.614 * Math.pow(lv, 1.06216) / 100) * 100;
    }
    function levelFromPoints(p) {
        var lv = 1;
        while (lv < MAX_LEVEL && levelThreshold(lv + 1) <= p) lv++;
        return lv;
    }
    function fmtK(n) {
        n = Math.floor(n);
        if (n >= 1e6) { var s = (n / 1e6).toFixed(1); if (s.endsWith(".0")) s = s.slice(0, -2); return s + "M"; }
        if (n >= 1e3) { var t = (n / 1e3).toFixed(1); if (t.endsWith(".0")) t = t.slice(0, -2); return t + "K"; }
        return String(n);
    }
    function toast(t) { try { wg.ui.toast(String(t)); } catch (_) {} }
    function log(t)   { try { wg.log.write("info", "richfrog", String(t)); } catch (_) {} }

    function get(key, dflt)  { try { var v = wg.kv.get(key); return v === null || v === undefined ? dflt : v; } catch (_) { return dflt; } }
    function set(key, v)     { try { wg.kv.set(key, v); } catch (_) {} }
    function getBool(key, d) { var v = get(key, d); return v === true || v === "true" || v === 1 || v === "1"; }

    // ---- свои значения ----
    function myId() { try { return wg.tg.myId(); } catch (_) { return ""; } }

    function refreshProfileBadge() {
        if (!getBool("show_rating", true)) {
            wg.ui.clearMutations("profileHeader");
            return;
        }
        var lv = Math.max(1, Math.min(MAX_LEVEL, parseInt(get("level", "1"), 10) || 1));
        var pts = Math.max(0, parseInt(get("points", "0"), 10) || 0);
        lv = levelFromPoints(pts);
        var badge = "Ур. " + lv + " · " + fmtK(pts) + " очков";
        var extra = [];
        if (getBool("show_username", true)) {
            var u = String(get("username", "") || "").replace(/^@/, "");
            if (u) extra.push("@" + u);
        }
        if (getBool("show_phone", true)) {
            var p = String(get("phone", "") || "");
            if (p) extra.push(p);
        }
        var full = badge + (extra.length ? "  ·  " + extra.join("  ·  ") : "");
        try {
            wg.ui.mutate({
                id: "richfrog_profile",
                target: "profileHeader",
                selector: { isMyProfile: "true" },
                properties: {
                    badge: full,
                    badgeColor: "#FF2D55"
                },
                priority: 100
            });
        } catch (e) { log("mutate: " + e); }
    }

    // ---- команды ----
    function handleSend(msg) {
        var text = (msg && typeof msg.text === "string") ? msg.text.trim() : "";
        if (!text) return wg.HookResult.continue();
        if (text === ".rf" || text === ".richfrog") {
            openMenu();
            return wg.HookResult.cancel("RichFrog меню");
        }
        var m = /^\.rf\s+(\S+)\s+([\s\S]+)$/i.exec(text);
        if (!m) return wg.HookResult.continue();
        var sub = m[1].toLowerCase(), val = m[2].trim();
        if (sub === "level")   { set("level", val); refreshProfileBadge(); toast("Уровень: " + val); }
        else if (sub === "points") { set("points", val); refreshProfileBadge(); toast("Очки: " + val); }
        else if (sub === "username") {
            val = val.replace(/^@/, "");
            set("username", val); refreshProfileBadge(); toast("Юзернейм: @" + val);
        }
        else if (sub === "phone")   { set("phone", val); refreshProfileBadge(); toast("Номер: " + val); }
        else { toast("Неизвестная подкоманда"); }
        return wg.HookResult.cancel("RichFrog");
    }

    // ---- подарки ----
    function openGifts() {
        var peer = "";
        try { peer = wg.messages.currentChat() || myId(); } catch (_) {}
        if (!peer) { toast("Открой чат"); return; }
        try {
            wg.fake.gifts(function (list) {
                list = Array.isArray(list) ? list : [];
                if (!list.length) { toast("Каталог пуст"); return; }
                var labels = list.slice(0, 30).map(function (g, i) {
                    var n = g.title || ("Подарок " + g.id);
                    if (typeof g.price === "number") n += " · " + g.price + "⭐";
                    return n;
                });
                labels.push("Отмена");
                wg.ui.actionSheet("🎁 Выбери подарок", "Всего: " + list.length, labels, function (idx) {
                    if (idx == null || idx < 0 || idx >= list.length) return;
                    var g = list[idx];
                    wg.ui.actionSheet("Кто дарит?", g.title || ("#" + g.id),
                        ["Собеседник дарит мне", "Я дарю собеседнику", "Отмена"], function (j) {
                            if (j !== 0 && j !== 1) return;
                            var incoming = (j === 0);
                            try {
                                wg.fake.sendGift(peer, g.id, { incoming: incoming, hideName: false }, function (ok) {
                                    toast(ok ? "Подарок добавлен локально" : "Не удалось");
                                });
                            } catch (e) { toast("Ошибка: " + e); }
                        });
                });
            });
        } catch (e) { toast("wg.fake.gifts недоступен: " + e); }
    }

    function clearGifts() {
        try { wg.fake.clear(); toast("Локальные подделки сняты"); }
        catch (e) { toast("Ошибка: " + e); }
    }

    // ---- подмена балансов ----
    function toggleStars() {
        var on = !getBool("stars_fake", false);
        set("stars_fake", on);
        try { wg.fake.starsBalance(on ? 1000000 : -1); toast(on ? "Баланс звёзд подменён" : "Настоящий баланс"); }
        catch (e) { toast("starsBalance: " + e); }
    }
    function toggleTon() {
        var on = !getBool("ton_fake", false);
        set("ton_fake", on);
        try { wg.fake.tonBalance(on ? 12.5 : -1); toast(on ? "TON подменён" : "Настоящий TON"); }
        catch (e) { toast("tonBalance: " + e); }
    }
    function togglePayments() {
        var on = !getBool("payments_off", false);
        set("payments_off", on);
        try { wg.fake.payments(on ? ["gift", "giftResale", "giftUpgrade"] : []); toast(on ? "Оплата отменяется локально" : "Оплата как обычно"); }
        catch (e) { toast("payments: " + e); }
    }

    // ---- меню ----
    function openMenu() {
        wg.ui.actionSheet("🐸 RichFrog", "Видно только тебе",
            ["Рейтинг профиля", "Настройки", "Мои подарки (каталог)", "Снять подделки",
             "Баланс Stars: " + (getBool("stars_fake") ? "ВКЛ" : "выкл"),
             "Баланс TON: " + (getBool("ton_fake") ? "ВКЛ" : "выкл"),
             "Отмена оплаты: " + (getBool("payments_off") ? "ВКЛ" : "выкл"),
             "Закрыть"],
            function (i) {
                if (i === 0) openRating();
                else if (i === 1) openSettings();
                else if (i === 2) openGifts();
                else if (i === 3) clearGifts();
                else if (i === 4) { toggleStars(); openMenu(); }
                else if (i === 5) { toggleTon(); openMenu(); }
                else if (i === 6) { togglePayments(); openMenu(); }
            });
    }

    function openRating() {
        var cur = Math.max(1, Math.min(MAX_LEVEL, parseInt(get("level", "1"), 10) || 1));
        wg.ui.actionSheet("Уровень", "Текущий: " + cur,
            [10, 20, 30, 40, 50, 60, 70, 72, 73, 80, 90, 100].map(function (n) { return "Уровень " + n; }).concat(["Отмена"]),
            function (i) {
                var picks = [10, 20, 30, 40, 50, 60, 70, 72, 73, 80, 90, 100];
                if (i == null || i < 0 || i >= picks.length) return;
                var lv = picks[i];
                set("level", String(lv));
                set("points", String(levelThreshold(lv)));
                refreshProfileBadge();
                toast("Уровень " + lv);
            });
    }

    function openSettings() {
        wg.ui.actionSheet("RichFrog — настройки", "Всё видно только тебе",
            ["Показывать рейтинг: " + (getBool("show_rating", true) ? "ВКЛ" : "выкл"),
             "Показывать юзернейм: " + (getBool("show_username", true) ? "ВКЛ" : "выкл"),
             "Показывать номер: " + (getBool("show_phone", true) ? "ВКЛ" : "выкл"),
             "Сбросить всё",
             "Назад"],
            function (i) {
                if (i === 0) { set("show_rating", !getBool("show_rating", true)); refreshProfileBadge(); openSettings(); }
                else if (i === 1) { set("show_username", !getBool("show_username", true)); refreshProfileBadge(); openSettings(); }
                else if (i === 2) { set("show_phone", !getBool("show_phone", true)); refreshProfileBadge(); openSettings(); }
                else if (i === 3) {
                    try { wg.kv.clear(""); } catch (_) {}
                    try { wg.ui.clearMutations("profileHeader"); } catch (_) {}
                    toast("Сброшено");
                }
                else if (i === 4) openMenu();
            });
    }

    // ---- регистрация ----
    function init() {
        // входящие команды
        try { wg.intercept("message.beforeSend", handleSend, { priority: 10 }); } catch (e) { log("intercept: " + e); }

        // пункт в меню сообщения
        try {
            wg.menu.addItem({
                id: "richfrog_open",
                title: "🐸 RichFrog",
                icon: "star",
                locations: ["message"],
                hookName: "richfrog:open"
            });
            wg.events.on("richfrog:open", function () { openMenu(); });
        } catch (e) { log("menu: " + e); }

        // страница настроек WhiteGram
        try {
            wg.screens.registerSettingsPage({
                id: "richfrog",
                title: "RichFrog",
                controls: [
                    { id: "show_rating",   type: "switch", title: "Показывать рейтинг",   default: true,  hookName: "rf:show_rating" },
                    { id: "show_username", type: "switch", title: "Показывать юзернейм", default: true,  hookName: "rf:show_username" },
                    { id: "show_phone",    type: "switch", title: "Показывать номер",    default: true,  hookName: "rf:show_phone" }
                ]
            });
            wg.events.on("rf:show_rating",   function () { refreshProfileBadge(); });
            wg.events.on("rf:show_username", function () { refreshProfileBadge(); });
            wg.events.on("rf:show_phone",    function () { refreshProfileBadge(); });
        } catch (e) { log("settings page: " + e); }

        refreshProfileBadge();
        toast("RichFrog готов. Напиши .rf");
    }

    if (typeof wg.registerPlugin === "function" && typeof wg.BasePlugin === "function") {
        class RichFrogPlugin extends wg.BasePlugin {
            onLoad() { init(); }
            onUnload() {
                try { wg.ui.clearMutations("profileHeader"); } catch (_) {}
                try { wg.fake.clear(); } catch (_) {}
            }
        }
        wg.registerPlugin(new RichFrogPlugin());
    } else {
        init();
    }
})();
