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
    "nav.cloud":      { zh: "云端体验", en: "Cloud Trial" },
    "nav.code":       { zh: "代码协作", en: "Code" },
    "nav.security":   { zh: "安全", en: "Security" },
    "nav.specs":      { zh: "规格", en: "Specs" },
    "nav.app":        { zh: "进入共序", en: "Open App" },

    "hero.eyebrow":   { zh: "[ ALPHA 预览版 · 邀请制测试 ]", en: "[ ALPHA PREVIEW · BY INVITATION ]" },
    "hero.l1":        { zh: "一个空间，汇聚众智。", en: "One room, many minds." },
    "hero.tagline":   { zh: "One room, many minds.", en: "一个空间，汇聚众智。" },
    "hero.copy":      { zh: "让多人在同一空间协作，各自使用本地 Agent，共享有序、可追溯、实时同步的上下文。",
                        en: "Where people collaborate in one shared workspace, each with their own local Agent, while context stays ordered, attributable, and live." },
    "hero.cta1":      { zh: "开始使用", en: "Get Started" },
    "hero.cta2":      { zh: "邮箱注册说明", en: "Email registration" },

    "statement.h2":   { zh: "不绑定具体 Agent harness。",
                        en: "It remains harness-neutral." },
    "statement.lead": { zh: "每位协作者都可以保留自己熟悉的本地 Agent 和工作方式。回复会标注用户名、harness、provider、模型和上下文保真度，不会向其他成员暴露本地设备或原生会话标识。",
                        en: "Every collaborator can keep the local Agent and workflow they already use. Responses are labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to other members." },

    "sessions.h2":      { zh: "两种会话：solo 与 multi。", en: "Two session modes: solo and multi." },
    "sessions.solo.h3": { zh: "Solo · 个人会话", en: "Solo" },
    "sessions.solo.p":  { zh: "由创建者发布完整的规范化会话事件流；项目内其他所有人只读，即使对方是项目创建者。",
                          en: "Its creator publishes a complete canonical session stream; every other project member follows it read-only — including the project owner." },
    "sessions.multi.h3": { zh: "Multi · 协作会话", en: "Multi" },
    "sessions.multi.p": { zh: "多人共享一个有序的项目会话。普通聊天不调用 Agent；可引用消息和 @成员。连接本地 Agent 后，请求由发送者的设备处理；云端体验 Agent 启用后需单独选择。",
                          en: "People share one ordered conversation. Chat does not run an Agent; quotes and mentions help find the discussion. Requests to a connected local Agent run on the sender's device; the cloud trial Agent requires a separate choice once enabled." },

    "context.h2":    { zh: "三种上下文保真度。", en: "Three explicit fidelity levels." },
    "context.lead":  { zh: "可选取部分历史请自己的 Agent 生成共享总结，随时切回原文。原始记录始终保留；本地 Agent 仍自行管理上下文压缩。",
                       en: "Ask your own Agent to summarize selected shared history, and switch back to the originals at any time. The original record remains; each local Agent still manages its own context compaction." },
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

    "connect.h2":    { zh: "通过服务器，随时接入同一项目。", en: "Meet in the same project, through one server." },
    "connect.lead":  { zh: "当前 Alpha 尚未开放公众注册。网页承载共享会话，Agent 与工作目录仍留在自己的设备上。", en: "Public registration has not opened on the hosted Alpha. The Web hosts shared sessions while your Agent and workspace stay on your device." },
    "connect.c1.h3": { zh: "打开共序", en: "Open GatherThread" },
    "connect.c1.p":  { zh: "使用邮箱和密码登录。首次使用请先验证邮箱，再自行设置密码。忘记密码时，可在登录页通过邮箱验证码重设。", en: "Sign in with email and password. New users verify their email and choose a password. Forgot password? Reset it with an email code on the sign-in page." },
    "connect.c1.link": { zh: "打开登录页 ↗", en: "Open sign in ↗" },
    "connect.c2.h3": { zh: "注册与项目权限", en: "Registration and projects" },
    "connect.c2.p":  { zh: "注册后可以创建项目，或接受邀请加入他人的项目。请先注册或登录，再接受邀请。注册默认关闭，开放情况以登录页提示为准。", en: "Create a project or accept an invitation to join one after signing in. Register or sign in before accepting invitations. Registration is closed by default; check the sign-in page for availability." },
    "connect.c2.link": { zh: "查看注册页面 ↗", en: "View registration \u2197" },
    "connect.c3.h3": { zh: "连接本地 Agent", en: "Connect your local Agent" },
    "connect.c3.p":  { zh: "在项目中连接自己的 Codex 或 DeepSeek Harness。模型、凭据和本地文件继续由本人管理。",
                       en: "Connect your own Codex or DeepSeek Harness to the project. Models, credentials, and local files remain under your control." },
    "connect.c3.link": { zh: "查看连接指南 ↗", en: "Read the connection guide ↗" },

    "setup.h2":      { zh: "连接你熟悉的 Agent。", en: "Connect the Agent you already use." },
    "setup.codex.1": { zh: "一次性安装固定版本的「共序 / GatherThread」Codex 插件。", en: "Install the fixed 共序 / GatherThread Codex plugin once." },
    "setup.codex.2": { zh: "复制连接命令；官方站点的 Windows / macOS 用户也可选用本地启动器。", en: "Copy the connector command; Windows and macOS users on the official site can optionally use a local Launcher." },
    "setup.codex.3": { zh: "重启 Codex Desktop，审查并启用插件 Hooks，然后保持连接器终端运行。", en: "Restart Codex Desktop, review and enable the plugin Hooks, then keep the connector terminal open." },
    "setup.dsh.1":   { zh: "把 @gatherthread/dsh-host 安装到已验证的 DSH Web profile。", en: "Install @gatherthread/dsh-host into the verified DSH Web profile." },
    "setup.dsh.2":   { zh: "启动 dsh web 并保持运行。", en: "Start dsh web and keep it running." },
    "setup.dsh.3":   { zh: "打开 Settings → GatherThread / 共序，输入当前服务器地址，并批准一次性配对码。", en: "Open Settings → GatherThread / 共序, enter the current server, and approve the one-use pairing code." },
    "setup.dsh.4":   { zh: "选择 Provider 和 Model，确认连接后即可在项目中使用。", en: "Choose a Provider and Model, then confirm the connection to use it in your projects." },

    "code.h2":      { zh: "选择适合项目的代码存储。", en: "Choose code storage that fits your project." },
    "code.lead":    { zh: "较大或长期项目推荐 GitHub，小项目试用可用 GT Cloud。GitHub 文件不计入共序云端额度，本地授权后可自动跟进代码改动；合并时再由成员审核。GitHub 接入仍为未发布源码预览。",
                      en: "We recommend GitHub for larger or long-term projects and GT Cloud for small trials. GitHub files do not count toward GT Cloud storage; after local authorization, settled changes upload automatically while merges remain under member review. GitHub integration is an unreleased source preview." },
    "code.c1.h3": { zh: "GitHub · 长期协作", en: "GitHub · long-term collaboration" },
    "code.c1.p":  { zh: "代码由本机直接传到 GitHub，共序不接收 GitHub 凭据或代码内容。仓库可见性与协作者权限在 GitHub 独立管理；暂停共序同步、移除成员或删除共序项目，都不会撤销 GitHub 权限或删除 GitHub 数据。",
                      en: "Code travels directly from your device to GitHub; GatherThread receives neither GitHub credentials nor source content. GitHub manages visibility and collaborator access independently. Pausing GT sync, removing a GT member or deleting a GT project does not revoke GitHub access or delete GitHub data." },
    "code.c2.h3": { zh: "GT Cloud · 小项目试用", en: "GT Cloud · small trials" },
    "code.c2.p":  { zh: "代码保存在共序服务器，仅用于本项目协作，所有项目成员均可阅读，Solo 不隔离代码。设置中可按权限清理 GT Cloud 数据，不影响本地 Git 或 GitHub；连接 GitHub 不会自动迁移或删除已有文件。",
                      en: "Code stays on the GatherThread server for this project's collaboration and is readable by every project member; Solo does not isolate code. Authorized GT Cloud cleanup leaves local Git and GitHub untouched. Connecting GitHub does not automatically migrate or delete existing files." },
    "cloud.h2":      { zh: "想先体验 Agent？试用隔离的云端工作区。", en: "Want to try an Agent first? Use an isolated cloud workspace." },
    "cloud.lead":    { zh: "云端体验 Agent 使用开源 OpenCode harness，可在临时容器里读写代码、执行终端命令和运行已有依赖的测试。另有面向 Node.js/TypeScript 的云端 GitHub 开发预览，提供仓库授权、npm 依赖准备、任务源码保存、改动查看及主动创建草稿 PR。目前仍待模型 API、GitHub App 接入与部署验证；服务启用后，可在工作页与 Codex、DSH 并列的 Agent 选择器及设置中选用云端模型，无需连接本地 Agent。",
                       en: "The cloud trial Agent uses the open-source OpenCode harness to edit code, run terminal commands, and test with dependencies already present in a temporary container. A separate Node.js/TypeScript GitHub preview adds repository authorization, npm dependency preparation, saved task source, change review and explicit draft PR creation. Model API, GitHub App integration and deployment validation are still pending; once enabled, select a cloud model beside Codex and DSH in the workspace or settings without connecting a local Agent." },
    "cloud.c1.h3":   { zh: "无需安装本地 Agent", en: "No local Agent installation" },
    "cloud.c1.p":    { zh: "在有写入权限的项目会话中直接发起一次云端请求。每日额度有限，运行结束后临时环境会清理。",
                       en: "Start a cloud request from a project session where you can write. Daily usage is limited, and the temporary environment is removed after the run." },
    "cloud.c2.h3":   { zh: "代码由你选择", en: "Choose whether to share code" },
    "cloud.c2.p":    { zh: "默认在空工作区试用。只有主动勾选后，才会读取项目已共享的 GT Cloud 代码，并将合规改动保存到你的 GT Cloud 分支；本地文件不会因此上传。",
                       en: "Try it in an empty workspace by default. Only after you opt in will it read code already shared in GT Cloud and save eligible changes to your own GT Cloud branch. This does not upload local files." },
    "cloud.c3.h3":   { zh: "清楚的运行边界", en: "Clear run limits" },
    "cloud.c3.p":    { zh: "云端容器没有通用外网访问，不能在线安装依赖；每次运行有时间、文件大小和模型用量限制。复杂项目仍适合连接自己的本地 Agent。",
                       en: "The cloud container has no general Internet access and cannot install dependencies online. Runs are limited by time, file size, and model usage. Use your own local Agent for larger projects." },
    "cloud.c3.link": { zh: "阅读使用指南 ↗", en: "Read the guide ↗" },


    "security.h2":   { zh: "安全机制与当前限制。", en: "Security and current limits." },
    "security.1.h3": { zh: "账号与设备授权", en: "Account and device access" },
    "security.1.p":  { zh: "使用 pepper 保护的账号与设备授权，只完整展示一次。", en: "Sign in with email and password, authorize your Agent devices separately, and revoke device access at any time." },
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
    "final.lead": { zh: "使用邮箱和密码登录。注册和找回密码是否可用，以登录页面提示为准。", en: "Sign in with email and password. The sign-in page shows registration and password recovery availability." },
    "final.cta1": { zh: "打开登录页", en: "Open sign in" },
    "final.cta2": { zh: "邮箱注册", en: "Email registration" },

    "foot.1": { zh: "¹ Alpha 预览版：当前线上尚未切换邮箱账号更新，也未开放公众注册或公共 Beta。", en: "\u00b9 Alpha preview: the hosted service has not switched to the email-account update or opened public registration/Beta." },
    "foot.2": { zh: "² 服务器使用 node:sqlite，因此需要 Node.js 24 或更新版本。",
                en: "² The server uses node:sqlite — Node.js 24 or newer is required." },
    "foot.3": { zh: "³ 用户先注册或登录，再接受项目邀请；Agent 使用独立设备授权。不要公开密码、验证码或账号与设备授权。", en: "\u00b3 Register or sign in before accepting project invitations; authorize Agent devices separately. Never publish passwords, email codes or device credentials." },
    "foot.contact": { zh: "联系与反馈：", en: "Contact & feedback:" },
    "foot.privacy": { zh: "隐私说明与账号注销", en: "Privacy & account deletion" },
    "foot.icp": { zh: "gatherthread.cn 备案：", en: "gatherthread.cn ICP filing:" },

    "doc.title": { zh: "GatherThread — 一个空间，汇聚众智。", en: "GatherThread — One room, many minds." },
    "nav.aria": { zh: "主导航", en: "Primary navigation" },
    "theme.aria": { zh: "切换黑夜 / 白天模式", en: "Toggle dark / light mode" },
    "copy.aria": { zh: "复制命令", en: "Copy command" },
    "copy.success": { zh: "命令已复制", en: "Command copied" },
    "copy.failed": { zh: "复制失败，请手动选择命令", en: "Copy failed; select the command manually" }
  };

  var lang = "zh";
  try {
    var savedLanguage = localStorage.getItem("gt-lang");
    if (savedLanguage === "zh" || savedLanguage === "en") {
      lang = savedLanguage;
    } else {
      // Preserve an existing workspace choice when this is the first home-page visit.
      var savedSettings = JSON.parse(localStorage.getItem("gatherthread.settings.v1") || "null");
      if (savedSettings && savedSettings.general && savedSettings.general.locale === "en") lang = "en";
      if (savedSettings && savedSettings.general && savedSettings.general.locale === "zh-CN") lang = "zh";
    }
  } catch (e) {}

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
  function applyLang(next, replayTitle, persist) {
    if (next !== "zh" && next !== "en") return;
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
    if (persist !== false) {
      try { localStorage.setItem("gt-lang", next); } catch (e) {}
    }
  }

  langToggle.addEventListener("click", function () {
    applyLang(lang === "zh" ? "en" : "zh", true);
  });

  window.addEventListener("storage", function (event) {
    if (event.key === "gt-lang" && (event.newValue === "zh" || event.newValue === "en")) {
      applyLang(event.newValue, false, false);
    }
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
