// Same-origin product presentation only; credentials and projects stay in /app/.
(() => {
  "use strict";
  const languageButton = document.getElementById("language");
  const menuButton = document.getElementById("menu");
  const navigation = document.getElementById("navigation");
  const tabs = [...document.querySelectorAll(".story-tab")];
  const panels = [...document.querySelectorAll(".story-panel")];
  const root = "https://github.com/TH060419/gatherthread/blob/main/docs/";
  let currentLanguage = "zh";
  function closeMenu(restoreFocus = false) {
    const wasOpen = menuButton.getAttribute("aria-expanded") === "true";
    if (restoreFocus && wasOpen) menuButton.focus();
    navigation.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute(
      "aria-label",
      currentLanguage === "zh" ? "打开导航" : "Open navigation",
    );
  }
  function setLanguage(language, persist = true) {
    if (language !== "zh" && language !== "en") return;
    if (persist) {
      try {
        localStorage.setItem("gt-lang", language);
      } catch {}
    }
    currentLanguage = language;
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-zh][data-en]").forEach((element) => {
      element.textContent = element.dataset[language];
    });
    document.querySelectorAll("[data-image]").forEach((image) => {
      image.src =
        "assets/product/" +
        document.documentElement.lang +
        "/" +
        image.dataset.image +
        ".jpg";
    });
    document
      .querySelectorAll("[data-alt-zh][data-alt-en]")
      .forEach((element) => {
        element.alt =
          language === "zh" ? element.dataset.altZh : element.dataset.altEn;
      });
    document.querySelectorAll("[data-example]").forEach((link) => {
      link.href =
        "./app/example.html?locale=" +
        (language === "zh" ? "zh-CN" : "en") +
        "&topic=browse";
    });
    [
      ["data-guide", "PRODUCT_GUIDE"],
      ["data-codex", "CODEX_CONNECT"],
      ["data-dsh", "DSH_CONNECT"],
    ].forEach(([attribute, name]) => {
      document.querySelectorAll("[" + attribute + "]").forEach((link) => {
        link.href = root + name + (language === "zh" ? ".zh-CN.md" : ".md");
      });
    });
    document.title =
      language === "zh"
        ? "GatherThread 共序 · 一起做项目"
        : "GatherThread · Build something together";
    document.querySelector('meta[name="description"]').content =
      language === "zh"
        ? "GatherThread 共序，让多人、多端、多 Agent 一起做项目。实时讨论，携手开发，随时接续。"
        : "GatherThread brings people, devices and their own Agents together. Discuss in real time, build together, and pick up anywhere.";
    languageButton.textContent = language === "zh" ? "EN" : "中文";
    languageButton.setAttribute(
      "aria-label",
      language === "zh" ? "Switch to English" : "切换到中文",
    );
    navigation.setAttribute(
      "aria-label",
      language === "zh" ? "主导航" : "Main navigation",
    );
    document
      .querySelector(".footer-links")
      .setAttribute(
        "aria-label",
        language === "zh"
          ? "资源与项目信息"
          : "Resources and project information",
      );
    document
      .querySelector(".product-stage")
      .setAttribute(
        "aria-label",
        language === "zh"
          ? "GatherThread 电脑与手机界面"
          : "GatherThread desktop and phone interfaces",
      );
    document
      .querySelector(".story-tabs")
      .setAttribute(
        "aria-label",
        language === "zh" ? "示例工作过程" : "Example workflow",
      );
    document
      .querySelector(".principles")
      .setAttribute(
        "aria-label",
        language === "zh"
          ? "协作的三个原则"
          : "Three principles of collaboration",
      );
    document
      .querySelector(".brand")
      .setAttribute(
        "aria-label",
        language === "zh" ? "GatherThread 共序首页" : "GatherThread home",
      );
    document
      .querySelector(".chapter-nav")
      .setAttribute(
        "aria-label",
        language === "zh" ? "章节导航" : "Chapter navigation",
      );
    document.querySelectorAll("[data-chapter-link]").forEach((link) => {
      link.setAttribute(
        "aria-label",
        language === "zh" ? link.dataset.labelZh : link.dataset.labelEn,
      );
    });
    requestAnimationFrame(() => {
      updateLens(false);
      updateActiveChapter();
    });
    const themeLabel =
      language === "zh" ? "切换明暗外观" : "Toggle light / dark appearance";
    document
      .getElementById("themeToggle")
      .setAttribute("aria-label", themeLabel);
    document.getElementById("themeToggle").title = themeLabel;
    const expanded = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute(
      "aria-label",
      language === "zh"
        ? expanded
          ? "关闭导航"
          : "打开导航"
        : expanded
          ? "Close navigation"
          : "Open navigation",
    );
  }
  languageButton.addEventListener("click", () =>
    setLanguage(currentLanguage === "zh" ? "en" : "zh"),
  );
  menuButton.addEventListener("click", (event) => {
    const expanded = menuButton.getAttribute("aria-expanded") !== "true";
    navigation.classList.toggle("is-open", expanded);
    menuButton.setAttribute("aria-expanded", String(expanded));
    // Keyboard opening lands inside the disclosed links; pointer opening stays put.
    if (expanded && event.detail === 0) navigation.querySelector("a")?.focus();
    menuButton.setAttribute(
      "aria-label",
      currentLanguage === "zh"
        ? expanded
          ? "关闭导航"
          : "打开导航"
        : expanded
          ? "Close navigation"
          : "Open navigation",
    );
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu(true);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-header")) closeMenu();
  });
  window.addEventListener(
    "resize",
    () => {
      if (window.innerWidth > 850) closeMenu();
    },
    { passive: true },
  );
  function activateStep(index, focus) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panels.forEach((panel, i) => {
      panel.hidden = i !== index;
    });
    updateLens(true);
    const panel = panels[index];
    animateLayers([panel], {
      distance: 9,
      duration: 340,
      finishPrevious: false,
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateStep(index, false));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight" || event.key === "ArrowDown")
        next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        activateStep(next, true);
      }
    });
  });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduceTransparency = window.matchMedia(
    "(prefers-reduced-transparency: reduce)",
  );
  const increaseContrast = window.matchMedia("(prefers-contrast: more)");
  const forcedColors = window.matchMedia("(forced-colors: active)");
  const motion = new Set();
  const motionEase = "cubic-bezier(.16,1,.3,1)";
  const lens = document.querySelector(".story-lens");
  const tabContainer = document.querySelector(".story-tabs");
  const chapterGlass = document.querySelector(".chapter-glass");
  const siteHeader = document.querySelector(".site-header");
  const headerInner = document.querySelector(".header-inner");
  const headerLogo = siteHeader.querySelector(".brand img");
  const darkSurfaces = [...document.querySelectorAll(".dark,.start-stage")];
  const backdropSupported =
    CSS.supports("backdrop-filter", "blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px)");
  const watermark = document.getElementById("hero-watermark");
  const brandLines = watermark.querySelector(".brand-thread-lines");
  const chapters = [...document.querySelectorAll("[data-chapter]")];
  const chapterLinks = [...document.querySelectorAll("[data-chapter-link]")];
  const fullChapterMotion = window.matchMedia(
    "(min-width:901px) and (min-height:620px)",
  );
  // Reuse the original .fx stagger in coherent three-layer groups.
  function markScene(element, kind) {
    if (element) element.classList.add("scroll-scene", "scroll-" + kind);
  }
  chapters.forEach((chapter) =>
    markScene(chapter.querySelector(".section-heading"), "heading"),
  );
  markScene(document.getElementById("hero-title"), "heading");
  markScene(document.getElementById("desktop-product"), "primary");
  markScene(document.getElementById("phone-product"), "secondary");
  markScene(document.querySelector(".feature-pair"), "primary");
  markScene(document.querySelector(".principles"), "secondary");
  const storyStage = document.createElement("div");
  storyStage.className = "story-stage scroll-scene scroll-primary";
  panels[0].before(storyStage);
  panels.forEach((panel) => storyStage.append(panel));
  markScene(tabContainer, "secondary");
  markScene(document.querySelector(".continuity-phone"), "primary");
  markScene(document.querySelector(".continuity-copy"), "secondary");
  markScene(document.querySelector(".storage-grid"), "primary");
  markScene(document.querySelector(".storage-note"), "secondary");
  markScene(document.querySelector(".faq-layout"), "primary");
  markScene(document.querySelector(".start-steps"), "primary");
  markScene(document.querySelector(".start-stage>.actions"), "secondary");
  const entered = new Set(["overview"]);
  let currentChapter = "overview";
  let motionGeneration = 0;
  let scrollFrame = 0;
  function track(animation) {
    motion.add(animation);
    animation.finished.then(
      () => motion.delete(animation),
      () => motion.delete(animation),
    );
    return animation;
  }
  function finishMotion() {
    motionGeneration++;
    motion.forEach((animation) => {
      try {
        animation.finish();
      } catch (error) {
        animation.cancel();
      }
    });
    motion.clear();
    brandLines.style.removeProperty("stroke-dashoffset");
  }
  function animateLayers(elements, options = {}) {
    if (options.finishPrevious !== false) finishMotion();
    if (reduceMotion.matches || document.hidden || !Element.prototype.animate)
      return;
    const available = Math.max(0, 3 - motion.size);
    elements
      .filter(Boolean)
      .slice(0, available)
      .forEach((element, index) => {
        track(
          element.animate(
            [
              {
                transform: "translateY(" + (options.distance || 20) + "px)",
                opacity: 0.91,
              },
              { transform: "translateY(0)", opacity: 1 },
            ],
            {
              duration: options.duration || 780,
              delay: index * 80,
              easing: motionEase,
              fill: "backwards",
            },
          ),
        );
      });
  }
  function updateLens(animate) {
    const selected =
      tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ||
      tabs[0];
    const oldTransform = lens.style.transform;
    const targetTransform =
      "translate3d(" +
      selected.offsetLeft +
      "px," +
      selected.offsetTop +
      "px,0)";
    if (animate) finishMotion();
    lens.style.width = selected.offsetWidth + "px";
    lens.style.height = selected.offsetHeight + "px";
    lens.style.transform = targetTransform;
    tabContainer.classList.add("has-lens");
    if (
      animate &&
      oldTransform &&
      oldTransform !== targetTransform &&
      !reduceMotion.matches &&
      !document.hidden &&
      lens.animate
    ) {
      track(
        lens.animate(
          [{ transform: oldTransform }, { transform: targetTransform }],
          { duration: 300, easing: "cubic-bezier(.2,.85,.3,1)" },
        ),
      );
    }
  }
  function updateActiveChapter() {
    updateHeaderMaterial();
    const probe = Math.min(window.innerHeight * 0.38, 360);
    let selected = chapters[0];
    const canReveal =
      fullChapterMotion.matches && !reduceMotion.matches && !document.hidden;
    chapters.forEach((chapter) => {
      const rect = chapter.getBoundingClientRect();
      if (rect.top <= probe) selected = chapter;
      // Old page-level45% threshold never reached on tallFAQ. Use the
      // chapter edge instead; once reading it, retain the fully visible state.
      if (canReveal && rect.top < window.innerHeight * 0.78 && rect.bottom > 0)
        chapter.classList.add("in-view");
      if (rect.top >= window.innerHeight || rect.bottom <= 0)
        chapter.classList.remove("in-view");
    });
    if (canReveal && window.scrollY > 10) {
      if (motion.size) finishMotion();
      const departure = Math.max(
        0,
        Math.min(
          1,
          -chapters[0].getBoundingClientRect().top / window.innerHeight,
        ),
      );
      watermark.style.translate = "0 " + (departure * 48).toFixed(2) + "px";
      // Exact branded paths, with the old scroll-draw formula reversed as
      // the logo leaves. It resolves immediately on reverse scroll.
      brandLines.style.strokeDashoffset = String(departure * 1000);
    } else {
      watermark.style.removeProperty("translate");
      if (!canReveal || !motion.size)
        brandLines.style.removeProperty("stroke-dashoffset");
    }
    if (selected.id !== currentChapter) {
      currentChapter = selected.id;
      chapterLinks.forEach((link) => {
        if (link.hash === "#" + currentChapter)
          link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }
    const rail = chapterGlass.getBoundingClientRect();
    chapterGlass.classList.toggle(
      "is-dark",
      Boolean(
        surfaceBehind(rail.top + rail.height / 2, rail.left + rail.width / 2),
      ),
    );
    chapterLinks.forEach((link) => {
      const dot = link.querySelector(".dot").getBoundingClientRect();
      link.classList.toggle(
        "is-on-dark",
        Boolean(
          surfaceBehind(dot.top + dot.height / 2, dot.left + dot.width / 2),
        ),
      );
    });
  }
  function surfaceBehind(y, x) {
    if (document.documentElement.getAttribute("data-theme") === "dark")
      return document.body;
    return darkSurfaces.find((surface) => {
      const rect = surface.getBoundingClientRect();
      return (
        rect.top <= y && rect.bottom > y && rect.left <= x && rect.right > x
      );
    });
  }
  function updateHeaderMaterial() {
    // Material follows the surface behind the header's actual center,
    // independently from the chapter rail's reading-position probe.
    const rect = headerInner.getBoundingClientRect();
    const surface = surfaceBehind(
      rect.top + rect.height / 2,
      rect.left + rect.width / 2,
    );
    const opaque =
      reduceTransparency.matches ||
      increaseContrast.matches ||
      forcedColors.matches ||
      !backdropSupported;
    const transition =
      !opaque &&
      darkSurfaces.some((candidate) => {
        const edge = candidate.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        if (x < edge.left || x >= edge.right) return false;
        return [edge.top, edge.bottom].some(
          (y) => y > rect.top - 10 && y < rect.bottom + 10,
        );
      });
    siteHeader.classList.toggle("is-over-dark", Boolean(surface));
    siteHeader.classList.toggle(
      "is-over-color",
      Boolean(surface && surface.classList.contains("start-stage")),
    );
    siteHeader.classList.toggle("is-transition", transition);
    let logo =
      document.documentElement.getAttribute("data-theme") === "dark" ||
      (surface && !opaque && !transition)
        ? "assets/lockup-color-transparent-dark.svg"
        : "assets/lockup-color-transparent-light.svg";
    if (forcedColors.matches) {
      // Forced palettes can use a black Canvas despite the ordinary light
      // opaque fallback. Select the unchanged official wordmark for Canvas.
      const color = getComputedStyle(headerInner).backgroundColor;
      const components = color.match(/[\d.]+/g);
      if (components && components.length >= 3) {
        const scale = color.startsWith("color(") ? 255 : 1;
        const linear = components.slice(0, 3).map((value) => {
          const channel = (Number(value) * scale) / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const luminance =
          0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        logo =
          luminance < 0.2
            ? "assets/lockup-color-transparent-dark.svg"
            : "assets/lockup-color-transparent-light.svg";
      }
    }
    if (headerLogo.getAttribute("src") !== logo)
      headerLogo.setAttribute("src", logo);
    document.querySelector(".footer-logo").src = forcedColors.matches
      ? logo
      : document.documentElement.getAttribute("data-theme") === "dark"
        ? "assets/lockup-color-transparent-dark.svg"
        : "assets/lockup-color-transparent-light.svg";
  }
  function scheduleActiveChapter() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateActiveChapter();
    });
  }
  function revealChapter(chapter) {
    if (document.hidden) return;
    chapter.classList.add("in-view");
    if (fullChapterMotion.matches && !reduceMotion.matches) {
      entered.add(chapter.id);
      return;
    }
    if (entered.has(chapter.id)) return;
    entered.add(chapter.id);
    const heading = chapter.querySelector(".section-heading");
    let content;
    let support;
    if (chapter.id === "together")
      content = chapter.querySelector(".feature-pair");
    if (chapter.id === "workflow") {
      content = tabContainer;
      support = chapter.querySelector(".story-panel:not([hidden])");
    }
    if (chapter.id === "devices") {
      content = chapter.querySelector(".continuity-phone");
      support = chapter.querySelector(".continuity-copy");
    }
    if (chapter.id === "files")
      content = chapter.querySelector(".storage-grid");
    if (chapter.id === "faq") content = chapter.querySelector(".faq-layout");
    if (chapter.id === "start") {
      content = chapter.querySelector(".start-steps");
      support = chapter.querySelector(".start-stage>.actions");
    }
    animateLayers([heading, content, support], { distance: 20, duration: 760 });
  }
  function settle() {
    if (reduceMotion.matches || document.hidden || !Element.prototype.animate)
      return;
    finishMotion();
    const generation = motionGeneration;
    const narrow = window.innerWidth <= 850;
    const markRect = watermark.getBoundingClientRect();
    const drawMark =
      !reduceTransparency.matches &&
      !increaseContrast.matches &&
      !forcedColors.matches &&
      markRect.width > 0 &&
      markRect.height > 0;
    if (drawMark) brandLines.style.strokeDashoffset = "1000";
    const frames = [
      [
        document.getElementById("hero-title"),
        [
          { transform: "translateY(28px)", opacity: 0 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        700,
        0,
      ],
      [
        document.getElementById("desktop-product"),
        [
          {
            transform: narrow
              ? "translateY(25px)"
              : "translateY(56px) rotateX(4deg) rotateY(-3deg)",
            opacity: 0,
          },
          {
            transform: "translateY(0) rotateX(0deg) rotateY(0deg)",
            opacity: 1,
          },
        ],
        1500,
        180,
      ],
      [
        document.getElementById("phone-product"),
        [
          {
            transform: narrow
              ? "translateY(28px)"
              : "translateY(72px) rotateZ(2.5deg)",
            opacity: 0,
          },
          { transform: "translateY(0) rotateZ(0deg)", opacity: 1 },
        ],
        1300,
        560,
      ],
    ];
    let titleAnimation;
    frames.forEach(([element, keyframes, duration, delay]) => {
      const animation = track(
        element.animate(keyframes, {
          duration,
          delay,
          easing: motionEase,
          fill: "backwards",
        }),
      );
      if (element.id === "hero-title") titleAnimation = animation;
    });
    if (drawMark && titleAnimation)
      titleAnimation.finished.then(
        () => {
          // finishMotion invalidates this continuation, including explicit finish,
          // preference changes, chapter entry, resize and backgrounding the page.
          if (generation !== motionGeneration) return;
          brandLines.style.removeProperty("stroke-dashoffset");
          const rect = watermark.getBoundingClientRect();
          if (
            document.hidden ||
            reduceMotion.matches ||
            reduceTransparency.matches ||
            increaseContrast.matches ||
            forcedColors.matches ||
            currentChapter !== "overview" ||
            rect.bottom <= 0 ||
            rect.top >= window.innerHeight ||
            rect.width === 0 ||
            motion.size >= 3
          )
            return;
          track(
            brandLines.animate(
              [{ strokeDashoffset: "1000" }, { strokeDashoffset: "0" }],
              { duration: 1200, easing: "cubic-bezier(.65,0,.35,1)" },
            ),
          );
        },
        () => {
          if (generation === motionGeneration)
            brandLines.style.removeProperty("stroke-dashoffset");
        },
      );
  }
  if ("IntersectionObserver" in window) {
    chapters
      .slice(1)
      .forEach((chapter) => chapter.classList.add("motion-ready"));
    // Observe a short heading, never a percentage of the whole tall chapter.
    const entrance = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting)
            revealChapter(entry.target.closest("[data-chapter]"));
        });
      },
      { threshold: 0, rootMargin: "-88px 0px -12% 0px" },
    );
    chapters.slice(1).forEach((chapter) => {
      const heading = chapter.querySelector(".section-heading");
      if (heading) entrance.observe(heading);
    });
  }
  window.addEventListener("scroll", scheduleActiveChapter, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      finishMotion();
      updateLens(false);
      scheduleActiveChapter();
    },
    { passive: true },
  );
  document.querySelectorAll(".faq details").forEach((details) => {
    details.addEventListener("toggle", scheduleActiveChapter);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) finishMotion();
    else {
      updateActiveChapter();
      chapters.slice(1).forEach((chapter) => {
        const heading = chapter.querySelector(".section-heading");
        const rect = heading.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.88 && rect.bottom > 88)
          revealChapter(chapter);
      });
    }
  });
  if (reduceMotion.addEventListener)
    reduceMotion.addEventListener("change", () => {
      if (reduceMotion.matches) finishMotion();
      updateLens(false);
      scheduleActiveChapter();
    });
  [reduceTransparency, increaseContrast, forcedColors].forEach((preference) => {
    if (preference.addEventListener)
      preference.addEventListener("change", () => {
        if (preference.matches) finishMotion();
        updateHeaderMaterial();
      });
  });
  const pointerCapable = window.matchMedia("(hover:hover) and (pointer:fine)");
  document.querySelectorAll(".button,.language,.github").forEach((control) => {
    control.classList.add("material-interactive");
    control.addEventListener(
      "pointermove",
      (event) => {
        if (
          reduceMotion.matches ||
          reduceTransparency.matches ||
          increaseContrast.matches ||
          !pointerCapable.matches
        )
          return;
        const rect = control.getBoundingClientRect();
        control.style.setProperty(
          "--glass-x",
          event.clientX - rect.left + "px",
        );
        control.style.setProperty("--glass-y", event.clientY - rect.top + "px");
      },
      { passive: true },
    );
    control.addEventListener(
      "pointerleave",
      () => {
        control.style.removeProperty("--glass-x");
        control.style.removeProperty("--glass-y");
      },
      { passive: true },
    );
  });
  if ("ResizeObserver" in window)
    new ResizeObserver(() => updateLens(false)).observe(tabContainer);
  document.fonts.ready.then(() => updateLens(false));
  let initialLanguage = "zh";
  try {
    const savedLanguage = localStorage.getItem("gt-lang");
    if (savedLanguage === "zh" || savedLanguage === "en")
      initialLanguage = savedLanguage;
    else {
      const savedSettings = JSON.parse(
        localStorage.getItem("gatherthread.settings.v1") || "null",
      );
      if (savedSettings?.general?.locale === "en") initialLanguage = "en";
    }
  } catch {}
  setLanguage(initialLanguage);
  window.addEventListener("storage", (event) => {
    if (event.key === "gt-lang") setLanguage(event.newValue, false);
    if (
      event.key === "gt-theme" &&
      (event.newValue === "dark" || event.newValue === "light")
    ) {
      document.documentElement.setAttribute("data-theme", event.newValue);
      scheduleActiveChapter();
    }
  });
  document.getElementById("themeToggle").addEventListener("click", () => {
    const theme =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "light"
        : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("gt-theme", theme);
    } catch {}
    scheduleActiveChapter();
  });
  updateLens(false);
  document.documentElement.classList.add("glass-ready");
  updateActiveChapter();
  initChapterMotion();
  if (!location.hash && scrollY < 10) requestAnimationFrame(settle);
  function initChapterMotion() {
    "use strict";
    const root = document.documentElement;
    const chapters = [...document.querySelectorAll(".chapter[data-chapter]")];
    if (!chapters.length) return;
    const desktop = matchMedia("(min-width: 901px) and (min-height: 620px)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const scenes = chapters.flatMap((chapter) =>
      [...chapter.querySelectorAll(".scroll-scene")].map((element) => ({
        element,
        chapter,
        kind: element.classList.contains("scroll-heading")
          ? "heading"
          : element.classList.contains("scroll-secondary")
            ? "secondary"
            : "primary",
      })),
    );
    const watchedAnimations = new WeakSet();
    const modifiedScenes = new Set();
    const listeners = [];
    let geometry = [];
    let geometryDirty = true;
    let frame = 0;
    let activeLayers = 0;
    const clamp = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, value));

    function listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      listeners.push(() => target.removeEventListener(type, callback, options));
    }
    function resetScene(scene) {
      scene.element.style.removeProperty("translate");
      scene.element.style.removeProperty("scale");
      scene.element.style.removeProperty("will-change");
      modifiedScenes.delete(scene);
    }
    function resetMotion() {
      [...modifiedScenes].forEach(resetScene);
      activeLayers = 0;
    }
    function measure() {
      const y = window.scrollY;
      geometry = chapters.map((chapter) => {
        const rect = chapter.getBoundingClientRect();
        return {
          chapter,
          top: rect.top + y,
          height: rect.height,
          bottom: rect.bottom + y,
        };
      });
      geometryDirty = false;
    }
    function motionEnabled() {
      return desktop.matches && !reduced.matches && !document.hidden;
    }
    function scheduleRender() {
      if (!frame && !document.hidden) frame = requestAnimationFrame(render);
    }
    function render() {
      frame = 0;
      if (!motionEnabled()) {
        resetMotion();
        return;
      }
      if (geometryDirty) measure();
      const y = window.scrollY;
      const viewport = window.innerHeight;
      const candidates = [];
      const rects = new Map();
      // Read layout before style writes. Visual wrappers do not alter chapter
      // positions, native scrolling, or the chapter's CSS proximity snap area.
      geometry.forEach((item) =>
        rects.set(item.chapter, {
          top: item.top - y,
          bottom: item.bottom - y,
          height: item.height,
        }),
      );
      scenes.forEach((scene) => {
        // Text retains the old homepage's independent CSS entrance transition.
        if (scene.kind === "heading") return;
        const rect = rects.get(scene.chapter);
        if (rect.bottom <= 0 || rect.top >= viewport) return;
        const entering = clamp(rect.top / viewport, 0, 1);
        const exiting = clamp((viewport - rect.bottom) / viewport, 0, 1);
        // Oversized chapters stay flat throughout their readable interior.
        const translate =
          entering * (scene.kind === "secondary" ? 68 : 80) -
          exiting * (scene.kind === "secondary" ? 42 : 54);
        const scale =
          scene.kind === "primary" ? 1 - entering * 0.1 - exiting * 0.035 : 1;
        if (Math.abs(translate) < 0.2 && Math.abs(scale - 1) < 0.0003) return;
        const visible =
          Math.max(0, Math.min(viewport, rect.bottom) - Math.max(0, rect.top)) /
          viewport;
        const priority =
          (scene.kind === "primary" ? 0 : 0.2) + (1 - visible) * 0.32;
        candidates.push({ scene, translate, scale, priority });
      });
      const introLayers = motion.size;
      // At most two continuous visuals, reserving a third layer for text entry.
      const budget = Math.min(2, Math.max(0, 3 - Math.max(1, introLayers)));
      const selected = candidates
        .sort((a, b) => a.priority - b.priority)
        .slice(0, budget);
      const selectedScenes = new Set(
        selected.map((candidate) => candidate.scene),
      );
      [...modifiedScenes].forEach((scene) => {
        if (!selectedScenes.has(scene)) resetScene(scene);
      });
      selected.forEach(({ scene, translate, scale }) => {
        scene.element.style.translate = "0 " + translate.toFixed(2) + "px";
        if (scene.kind === "primary")
          scene.element.style.scale = scale.toFixed(4);
        else scene.element.style.removeProperty("scale");
        scene.element.style.willChange =
          scene.kind === "primary" ? "translate, scale" : "translate";
        modifiedScenes.add(scene);
      });
      activeLayers = selected.length;
      // One paint after each finite intro completion, not an autonomous loop.
      if (introLayers)
        document.getAnimations().forEach((animation) => {
          if (!watchedAnimations.has(animation)) {
            watchedAnimations.add(animation);
            animation.finished.then(scheduleRender, scheduleRender);
          }
        });
    }
    function layoutChanged() {
      geometryDirty = true;
      scheduleRender();
    }

    listen(window, "scroll", scheduleRender, { passive: true });
    listen(document, "click", (event) => {
      if (
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target.closest("a[href]");
      if (
        !anchor ||
        anchor.download ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      const url = new URL(anchor.href, location.href);
      if (
        url.origin !== location.origin ||
        url.pathname !== location.pathname ||
        url.search !== location.search ||
        !url.hash
      )
        return;
      const target = chapters.find((chapter) => "#" + chapter.id === url.hash);
      if (!target) return;
      event.preventDefault();
      const headerOffset =
        Number.parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
      const position = Math.max(
        0,
        target.getBoundingClientRect().top + window.scrollY - headerOffset,
      );
      if (location.hash !== url.hash) history.pushState(null, "", url.hash);
      // Maintain the chapter link's keyboard destination without extra Tab stops.
      if (target.hasAttribute("tabindex"))
        target.focus({ preventScroll: true });
      window.scrollTo({
        top: position,
        behavior: reduced.matches ? "auto" : "smooth",
      });
    });
    listen(window, "resize", layoutChanged, { passive: true });
    listen(window, "hashchange", layoutChanged);
    listen(window, "popstate", layoutChanged);
    listen(
      document,
      "toggle",
      (event) => {
        if (event.target instanceof HTMLDetailsElement) layoutChanged();
      },
      true,
    );
    listen(document, "visibilitychange", () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
        resetMotion();
      } else layoutChanged();
    });
    [desktop, reduced].forEach((preference) =>
      listen(preference, "change", () => {
        resetMotion();
        layoutChanged();
      }),
    );
    document.querySelectorAll("img").forEach((image) => {
      if (!image.complete) listen(image, "load", layoutChanged, { once: true });
    });
    if (document.fonts) document.fonts.ready.then(layoutChanged);
    const observer =
      "ResizeObserver" in window ? new ResizeObserver(layoutChanged) : null;
    if (observer) chapters.forEach((chapter) => observer.observe(chapter));
    listen(window, "pagehide", (event) => {
      cancelAnimationFrame(frame);
      frame = 0;
      resetMotion();
      if (!event.persisted) {
        observer?.disconnect();
        listeners.splice(0).forEach((remove) => remove());
      }
    });
    listen(window, "pageshow", layoutChanged);

    scheduleRender();
  }
})();
