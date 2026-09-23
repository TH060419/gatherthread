// GatherThread product page — interactions
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ==================== I18N ==================== */
  /* zh 严格对照 README.zh-CN.md；en 严格对照 README.md */
  var I18N = {
    "nav.sessions":   { zh: "会话", en: "Sessions" },
    "nav.context":    { zh: "上下文", en: "Context" },
    "nav.connect":    { zh: "连接", en: "Connect" },
    "nav.security":   { zh: "安全", en: "Security" },
    "nav.specs":      { zh: "规格", en: "Specs" },
    "nav.app":        { zh: "进入共序", en: "Open App" },

    "hero.eyebrow":   { zh: "[ 0.1.0-ALPHA.7 · ALPHA 预览版 ]", en: "[ 0.1.0-ALPHA.7 · ALPHA PREVIEW ]" },
    "hero.l1":        { zh: "一个空间，汇聚众智。", en: "One room, many minds." },
    "hero.tagline":   { zh: "One room, many minds.", en: "一个空间，汇聚众智。" },
    "hero.copy":      { zh: "让多人在同一空间协作，各自使用本地 Agent，共享有序、可追溯、实时同步的上下文。",
                        en: "Where people collaborate in one shared workspace, each with their own local Agent, while context stays ordered, attributable, and live." },
    "hero.cta1":      { zh: "开始使用", en: "Get Started" },
    "hero.cta2":      { zh: "在 GitHub 上查看", en: "View on GitHub" },

    "statement.h2":   { zh: "不绑定具体 Agent harness。",
                        en: "It remains harness-neutral." },
    "statement.lead": { zh: "每位协作者都可以保留自己熟悉的本地 Agent 和工作方式。回复会标注用户名、harness、provider、模型和上下文保真度，不会向其他成员暴露本地设备或原生会话标识。",
                        en: "Every collaborator can keep the local Agent and workflow they already use. Responses are labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to other members." },

    "sessions.h2":      { zh: "两种会话：solo 与 multi。", en: "Two session modes: solo and multi." },
    "sessions.solo.h3": { zh: "Solo · 个人会话", en: "Solo" },
    "sessions.solo.p":  { zh: "由创建者发布完整的规范化会话事件流；项目内其他所有人只读，即使对方是项目创建者。",
                          en: "Its creator publishes a complete canonical session stream; every other project member follows it read-only — including the project owner." },
    "sessions.multi.h3": { zh: "Multi · 协作会话", en: "Multi" },
    "sessions.multi.p": { zh: "多人共享一个有序的项目会话。普通聊天消息只进入共享会话，不会调用 Agent；Agent 请求只由发送者自己的本地 runtime 领取。",
                          en: "People share one ordered project conversation. A human chat message is shared without invoking an agent; an agent request is claimed only by the sender's local runtime." },

    "context.h2":    { zh: "三种上下文保真度。", en: "Three explicit fidelity levels." },
    "context.lead":  { zh: "根据历史重建的上下文绝不会被标记为 provider_request；上下文压缩由每个本地 Agent 自行处理，共享的规范事件日志保持完整和持久。",
                       en: "Reconstructed history is never labelled provider_request. Compaction remains local; the shared canonical log stays durable." },
    "context.r1.h3": { zh: "规范历史", en: "Canonical history" },
    "context.r1.p":  { zh: "该成员可见的完整共享事件历史。服务器以 SQLite WAL 持久化只追加的规范事件日志，为每个会话分配权威序号。",
                       en: "The complete shared event history visible to that member. The server persists an append-only canonical event log in SQLite WAL and assigns authoritative per-session sequence numbers." },
    "context.r2.h3": { zh: "Harness 转录", en: "Harness transcript" },
    "context.r2.p":  { zh: "从已授权的本地 harness 会话记录中实际观察到的内容，经解析与脱敏后进入共享历史。",
                       en: "Content actually observed in an authorized local harness transcript, parsed and redacted before entering the shared history." },
    "context.r3.h3": { zh: "Provider 请求", en: "Provider request" },
    "context.r3.p":  { zh: "由明确授权的 harness hook 或 provider 代理观察到的原始请求。未获明确授权并确认前，一律不上传。",
                       en: "The raw request observed by an explicitly authorized harness hook or provider proxy. Never uploaded without explicit authorization and confirmation." },

    "divider.caption": { zh: "有序 · 可追溯 · 实时同步", en: "Ordered · Attributable · Live" },

    "connect.h2":    { zh: "无需云账户，三种连接方式。", en: "Three connection modes, no cloud account." },
    "connect.lead":  { zh: "它们会保留同一个私有 .env、数据库、凭据 Pepper、用户和历史。",
                       en: "All three preserve the same private .env, database, credential pepper, users, and history." },
    "connect.c1.h3": { zh: "仅本机", en: "Local-only" },
    "connect.c1.p":  { zh: "一台电脑完整测试，不开放网络。",
                       en: "One computer for a complete test; no network exposure." },
    "connect.c2.h3": { zh: "局域网 HTTPS", en: "LAN HTTPS" },
    "connect.c2.p":  { zh: "同一可信局域网内的已知设备；自动选址并启动两个服务。",
                       en: "Known devices on one trusted LAN; address selection and both services are automatic." },
    "connect.c3.h3": { zh: "Tailscale Serve", en: "Tailscale Serve" },
    "connect.c3.p":  { zh: "跨网络的小规模已知协作者。",
                       en: "A small group of known collaborators across networks." },

    "setup.h2":      { zh: "三步，接入你的 Agent。", en: "Connect your Agent in three steps." },
    "setup.codex.1": { zh: "一次性安装固定版本的「共序 / GatherThread」Codex 插件。", en: "Install the fixed 共序 / GatherThread Codex plugin once." },
    "setup.codex.2": { zh: "复制网页生成的 macOS / Linux 或 PowerShell 连接命令。", en: "Copy the generated macOS / Linux or PowerShell connector command." },
    "setup.codex.3": { zh: "重启 Codex Desktop，审查并启用插件 Hooks，然后保持连接器终端运行。", en: "Restart Codex Desktop, review and enable the plugin Hooks, then keep the connector terminal open." },
    "setup.dsh.1":   { zh: "把 @gatherthread/dsh-host 安装到已验证的 DSH Web profile。", en: "Install @gatherthread/dsh-host into the verified DSH Web profile." },
    "setup.dsh.2":   { zh: "启动 dsh web 并保持运行。", en: "Start dsh web and keep it running." },
    "setup.dsh.3":   { zh: "打开 Settings → GatherThread / 共序，输入当前服务器地址，并批准一次性配对码。", en: "Open Settings → GatherThread / 共序, enter the current server, and approve the one-use pairing code." },

    "security.h2":   { zh: "安全机制与当前限制。", en: "Security and current limits." },
    "security.1.h3": { zh: "设备凭据", en: "Device credentials" },
    "security.1.p":  { zh: "使用 pepper 保护的设备凭据，只完整展示一次。", en: "Peppered device credentials, shown in full only once." },
    "security.2.h3": { zh: "可撤销会话", en: "Revocable sessions" },
    "security.2.p":  { zh: "仅存 HMAC 摘要且可撤销的浏览器会话。", en: "Browser sessions storing only HMAC digests, revocable." },
    "security.3.h3": { zh: "一次性授权", en: "One-use authorization" },
    "security.3.p":  { zh: "一次性邀请与设备授权，用完即废。", en: "Single-use invitations and device authorization." },
    "security.4.h3": { zh: "实时连接 ticket", en: "Realtime tickets" },
    "security.4.p":  { zh: "30 秒有效、一次性、限定会话。", en: "30-second, one-use, session-scoped tickets." },
    "security.5.h3": { zh: "访问控制", en: "Access control" },
    "security.5.p":  { zh: "solo / multi ACL 与基于角色的访问控制。", en: "solo / multi ACL with role-based access control." },
    "security.6.h3": { zh: "事件脱敏", en: "Event redaction" },
    "security.6.p":  { zh: "不暴露本地设备或原生会话标识。", en: "Local device and native-session identifiers are not exposed." },
    "security.7.h3": { zh: "限流与配额", en: "Rate limits & quotas" },
    "security.7.p":  { zh: "按设备限流，事件与快照任务存储配额。", en: "Per-device rate limits; event and snapshot-job storage quotas." },
    "security.8.h3": { zh: "备份与恢复", en: "Backup & restore" },
    "security.8.p":  { zh: "SQLite 备份 / 恢复脚本开箱即用。", en: "SQLite backup / restore scripts included." },

    "specs.1": { zh: "Node.js 或更新版本", en: "Node.js or newer" },
    "specs.2": { zh: "SQLite 规范事件日志", en: "SQLite canonical event log" },
    "specs.3": { zh: "WebSocket 实时推送", en: "WebSocket live delivery" },
    "specs.4": { zh: "Apache License", en: "Apache License" },

    "final.h2":  { zh: "进入共序，开始协作。", en: "Enter GatherThread and start collaborating." },
    "final.cta1": { zh: "打开登录页", en: "Open sign in" },
    "final.cta2": { zh: "阅读运行指南", en: "Read the run guide" },

    "foot.1": { zh: "¹ Alpha 预览版：共序官方服务器尚未开放；本机、局域网 HTTPS 与私有 Tailscale Serve 现在可用。",
                en: "¹ Alpha preview: the hosted GatherThread service is not open; local-only, private LAN HTTPS, and private Tailscale Serve are available." },
    "foot.2": { zh: "² 服务器使用 node:sqlite，因此需要 Node.js 24 或更新版本。",
                en: "² The server uses node:sqlite — Node.js 24 or newer is required." },
    "foot.3": { zh: "³ 局域网模式要求客户端显式信任专用本地 CA，不能绕过证书警告，也不能配置路由器端口转发。",
                en: "³ LAN mode requires clients to explicitly trust the dedicated local CA; never bypass a certificate warning or expose the port through the router." },
    "foot.contact": { zh: "联系与反馈：", en: "Contact & feedback:" },
    "foot.icp": { zh: "gatherthread.cn 备案：", en: "gatherthread.cn ICP filing:" },

    "doc.title": { zh: "GatherThread — 一个空间，汇聚众智。", en: "GatherThread — One room, many minds." },
    "nav.aria": { zh: "主导航", en: "Primary navigation" },
    "theme.aria": { zh: "切换黑夜 / 白天模式", en: "Toggle dark / light mode" },
    "copy.aria": { zh: "复制命令", en: "Copy command" },
    "copy.success": { zh: "命令已复制", en: "Command copied" },
    "copy.failed": { zh: "复制失败，请手动选择命令", en: "Copy failed; select the command manually" }
  };

  var lang = "zh";
  try { lang = localStorage.getItem("gt-lang") || "zh"; } catch (e) {}

  var title = document.getElementById("heroTitle");
  var themeToggle = document.getElementById("themeToggle");
  var langToggle = document.getElementById("langToggle");

  /* ---------- Hero title: character stagger ---------- */
  function renderTitle(replay) {
    var charIndex = 0;
    title.querySelectorAll("[data-split]").forEach(function (line) {
      var key = line.getAttribute("data-i18n");
      var text = (I18N[key] && I18N[key][lang]) || line.textContent;
      line.innerHTML = "";
      Array.prototype.forEach.call(text, function (ch) {
        var span = document.createElement("span");
        span.className = "char";
        span.textContent = ch === " " ? " " : ch;
        span.style.setProperty("--d", (0.15 + charIndex * 0.045).toFixed(3) + "s");
        charIndex++;
        line.appendChild(span);
      });
    });
    title.setAttribute("aria-label", (I18N["hero.l1"] || {})[lang] || "");
    if (replay) {
      title.classList.remove("in");
      void title.offsetWidth; // reflow to restart the transition
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        title.classList.add("in");
      });
    });
  }

  /* ---------- Language ---------- */
  function applyLang(next, replayTitle) {
    lang = next;
    root.setAttribute("lang", next === "zh" ? "zh-CN" : "en");
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (el.hasAttribute("data-split")) return; // hero title handled separately
      var entry = I18N[key];
      if (entry && entry[next] != null) el.innerHTML = entry[next];
    });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      var entry = I18N[el.getAttribute("data-i18n-aria")];
      if (entry && entry[next] != null) el.setAttribute("aria-label", entry[next]);
    });
    document.title = I18N["doc.title"][next];
    themeToggle.setAttribute("aria-label", I18N["theme.aria"][next]);
    themeToggle.setAttribute("title", I18N["theme.aria"][next]);
    langToggle.textContent = next === "zh" ? "EN" : "中";
    renderTitle(replayTitle);
    try { localStorage.setItem("gt-lang", next); } catch (e) {}
  }

  langToggle.addEventListener("click", function () {
    applyLang(lang === "zh" ? "en" : "zh", true);
  });

  /* ---------- Theme toggle ---------- */
  themeToggle.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("gt-theme", next); } catch (e) {}
  });

  /* ---------- Nav hairline on scroll ---------- */
  var nav = document.getElementById("nav");
  function onNavScroll() {
    nav.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onNavScroll, { passive: true });
  onNavScroll();

  /* ---------- Initial language + title ---------- */
  applyLang(lang, false);

  /* ---------- Hero mark: thread draw-in ---------- */
  var mark = document.querySelector(".hero-mark");
  setTimeout(function () {
    mark.classList.add("drawn");
  }, reduceMotion ? 0 : 900);

  /* ---------- Page snap: staggered fade in/out ---------- */
  var pages = document.querySelectorAll(".page");
  pages.forEach(function (page) {
    page.querySelectorAll(".fx").forEach(function (el, i) {
      el.style.setProperty("--fd", (i * 0.08).toFixed(2) + "s");
    });
  });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        entry.target.classList.toggle("in", entry.isIntersecting);
      });
    }, { threshold: 0.45 });
    pages.forEach(function (page) { io.observe(page); });
  } else {
    pages.forEach(function (page) { page.classList.add("in"); });
  }
  // 首屏页立即标记进入，避免 IO 回调延迟导致首屏内容空白
  if (pages.length) pages[0].classList.add("in");

  /* ---------- Thread divider: scroll-drawn line ---------- */
  var divider = document.querySelector(".thread-divider");
  var dividerPath = document.getElementById("dividerPath");
  if (!reduceMotion && divider) {
    var ticking = false;
    var updateDivider = function () {
      ticking = false;
      var rect = divider.getBoundingClientRect();
      var vh = window.innerHeight;
      var start = vh;
      var end = vh * 0.4;
      var p = (start - rect.top) / (start - end);
      p = Math.max(0, Math.min(1, p));
      dividerPath.style.setProperty("--p", p.toFixed(4));
    };
    window.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(updateDivider);
      }
    }, { passive: true });
    updateDivider();
  } else if (dividerPath) {
    dividerPath.style.setProperty("--p", "1");
  }

  /* ---------- Liquid glass: pointer-tracked specular sheen ---------- */
  document.querySelectorAll(".card, .col").forEach(function (el) {
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(2) + "%");
      el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(2) + "%");
    }, { passive: true });
  });

  /* ---------- Copy buttons ---------- */
  var copyStatus = document.getElementById("copyStatus");
  var announceCopyStatus = function (message) {
    if (!copyStatus) return;
    copyStatus.textContent = "";
    setTimeout(function () { copyStatus.textContent = message; }, 0);
  };
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var originalLabel = btn.getAttribute("aria-label") || I18N["copy.aria"][lang];
      var done = function () {
        btn.classList.add("copied");
        announceCopyStatus(I18N["copy.success"][lang]);
        setTimeout(function () { btn.classList.remove("copied"); }, 1600);
      };
      var failed = function () {
        btn.classList.add("copy-failed");
        btn.setAttribute("aria-label", I18N["copy.failed"][lang]);
        btn.setAttribute("title", I18N["copy.failed"][lang]);
        announceCopyStatus(I18N["copy.failed"][lang]);
        setTimeout(function () {
          btn.classList.remove("copy-failed");
          btn.setAttribute("aria-label", originalLabel);
          btn.removeAttribute("title");
        }, 2200);
      };
      if (!text) {
        failed();
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, failed);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var copied = false;
        try { copied = document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        if (copied) done();
        else failed();
      }
    });
  });

  /* ---------- Fixed color field: rAF-driven motion ---------- */
  var field = document.querySelector(".bg-field");
  if (field && !reduceMotion) {
    var orbs = [
      { el: field.querySelector(".o1"), ax: 12, ay: 10, wx: 0.00042, wy: 0.00036, px: 0.0, py: 1.3, ws: 0.00050, ps: 0.4 },
      { el: field.querySelector(".o2"), ax: 13, ay: 11, wx: 0.00038, wy: 0.00044, px: 2.1, py: 0.6, ws: 0.00044, ps: 1.9 },
      { el: field.querySelector(".o3"), ax: 11, ay: 9,  wx: 0.00040, wy: 0.00034, px: 4.0, py: 2.8, ws: 0.00047, ps: 3.1 },
      { el: field.querySelector(".o4"), ax: 12, ay: 10, wx: 0.00036, wy: 0.00042, px: 1.7, py: 3.9, ws: 0.00052, ps: 5.0 }
    ].filter(function (o) { return o.el; });
    var ring1 = field.querySelector(".r1");
    var ring2 = field.querySelector(".r2");

    var tick = function (t) {
      for (var i = 0; i < orbs.length; i++) {
        var o = orbs[i];
        var dx = Math.sin(t * o.wx + o.px) * o.ax;
        var dy = Math.cos(t * o.wy + o.py) * o.ay;
        var sc = 1 + Math.sin(t * o.ws + o.ps) * 0.09;
        o.el.style.transform = "translate(" + dx.toFixed(2) + "vw," + dy.toFixed(2) + "vh) scale(" + sc.toFixed(3) + ")";
      }
      if (ring1) ring1.style.transform = "rotate(" + ((t * 0.012) % 360).toFixed(2) + "deg)";
      if (ring2) ring2.style.transform = "rotate(" + ((-t * 0.009) % 360).toFixed(2) + "deg)";
      field.style.filter = "hue-rotate(" + (Math.sin(t * 0.0001) * 25).toFixed(2) + "deg)";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
})();
