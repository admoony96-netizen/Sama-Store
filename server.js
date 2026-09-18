// سيرفر سما ستور — يقرا سلة شي إن (الموقع الكويتي) ويحسب السعر بالدينار العراقي
//
// كيف يشتغل:
//   1) الواجهة (index.html) ترسل رابط السلة إلى POST /api/calculate
//   2) السيرفر يفتح الرابط بمتصفح مخفي (Playwright/Chromium) متنكر كموبايل
//   3) يقرا سعر كل قطعة بالدولار من صفحة السلة، يضربها × USD_TO_IQD
//   4) يرجع مجموع السلة كامل + عدد القطع

import express from "express";
import cors from "cors";
import { chromium, devices } from "playwright";

const app = express();

// يسمح لأي موقع (زي Netlify) يتواصل مع هذا السيرفر
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));
app.options(/.*/, cors());
app.use(express.json());

// نسجل كل طلب يوصل للسيرفر — حتى نتأكد هل الطلبات توصل أصلاً أو لا
app.use((req, res, next) => {
  console.log(`📥 طلب جديد: ${req.method} ${req.path} — من: ${req.headers.origin || "غير معروف"}`);
  next();
});

// نمسك أي خطأ غير متوقع يطيح السيرفر (بدل ما يطيح بصمت بدون أي سجل)
process.on("uncaughtException", (err) => {
  console.error("❌ خطأ غير متوقع (uncaughtException):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ خطأ غير متوقع (unhandledRejection):", err);
});

// سعر صرف الدولار بالدينار العراقي — غيّره من هنا إذا تغير السعر
const USD_TO_IQD = 1320;

// المنفذ (port) اللي يشتغل عليه السيرفر
const PORT = process.env.PORT || 3000;

// بعض صفحات شي إن تسوي تنقّل داخلي (redirect/تحديث) بعد التحميل الأولي،
// وهذا يخلي أي page.evaluate() قيد التنفيذ يفشل برسالة "Execution context
// was destroyed". هذي الدالة تحاول مرة ثانية تلقائياً بعد ما تستقر الصفحة.
async function safeEvaluate(page, fn) {
  try {
    return await page.evaluate(fn);
  } catch (err) {
    const msg = String((err && err.message) || "");
    if (msg.includes("context was destroyed") || msg.includes("Execution context") || msg.includes("Target closed")) {
      console.log("♻️ الصفحة تنقلت أثناء الفحص، ننتظر شوي ونعيد المحاولة...");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1500);
      return await page.evaluate(fn);
    }
    throw err;
  }
}

// شي إن يحمّل عناصر السلة تدريجياً كلما "تنزل" بالصفحة (lazy load).
// هذي الدالة تنزل بالصفحة خطوة خطوة، تعطي وقت للتحميل بين كل خطوة،
// حتى تظهر كل العناصر قبل ما نبدأ نقراها.
async function autoScroll(page, steps = 8, pauseMs = 700) {
  for (let i = 0; i < steps; i++) {
    try {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    } catch (e) {
      break; // الصفحة تنقلت أو انسكرت، نوقف السكرول بهدوء
    }
    await page.waitForTimeout(pauseMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
}

// ننتظر لين تظهر أرقام أسعار فعلية بنص الصفحة (نمط "رقم.رقمين")، بدل
// انتظار وقت ثابت قد يكون قصير أو طويل زيادة عن اللزوم.
async function waitForPricesToAppear(page, maxWaitMs = 12000, intervalMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const found = await page
      .evaluate(() => /\d+\.\d{2}/.test(document.body.innerText))
      .catch(() => false);
    if (found) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

app.get("/health", (req, res) => res.json({ ok: true }));

// رابط اختبار مباشر: يفتحه بالمتصفح مباشرة (GET) بدون أي علاقة بالواجهة
// أو Netlify، حتى نتأكد هل المتصفح المخفي (Chromium) يشتغل أصلاً بالسيرفر
app.get("/api/test-browser", async (req, res) => {
  console.log("🧪 اختبار المتصفح المخفي بدأ...");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    console.log("✅ المتصفح فتح بنجاح");
    const page = await browser.newPage();
    await page.goto("https://example.com", { timeout: 20000 });
    const title = await page.title();
    console.log("✅ فتح صفحة تجريبية بنجاح:", title);
    res.json({ ok: true, title });
  } catch (err) {
    console.error("❌ فشل اختبار المتصفح:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// رابط اختبار ثاني: يشغّل نفس منطق حساب السلة الحقيقي، بس عن طريق GET
// وباراميتر بالرابط، حتى تگدر تختبره مباشرة بالمتصفح بدون المرور بـ
// Netlify أو أي CORS. الاستخدام:
// /api/calculate-test?url=رابط_السلة_هنا (بعد ما تعمله encode)
app.get("/api/calculate-test", async (req, res) => {
  const cartUrl = req.query.url;
  console.log("🧪 اختبار حساب السلة — الرابط:", cartUrl);

  if (!cartUrl) {
    return res.status(400).json({ error: "ضيف ?url=رابط_السلة بنهاية الرابط" });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "ar-KW",
    });
    const page = await context.newPage();

    console.log("🚀 جاري فتح رابط السلة...");
    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
      console.log("⚠️ networkidle ما وصل بالوقت المحدد، نكمل نشوف وين وصلنا:", e.message);
    });

    await waitForPricesToAppear(page);
    await autoScroll(page);

    const finalUrl = page.url();
    console.log("📍 الرابط النهائي بعد التحويلات:", finalUrl);

    const pageTitle = await page.title();
    const htmlContent = await page.content();

    const shareCodeMatch = cartUrl.match(/shc=([^&]+)/);
    const shareCode = shareCodeMatch ? shareCodeMatch[1] : null;
    const shareCodeSurvived = shareCode ? htmlContent.includes(shareCode) : null;

    const bodyTextSample = await safeEvaluate(page, () => document.body.innerText.slice(0, 1500));
    const bodyTextFull = await safeEvaluate(page, () => document.body.innerText);
    const bodyTextTail = bodyTextFull.slice(-2000);
    console.log("📏 طول كامل نص الصفحة:", bodyTextFull.length);

    // نفس منطق الحساب الحقيقي — حتى نتأكد من النتيجة قبل ربطها بالواجهة
    // بس هالمرة نربط كل سعر باسم المنتج المجاور له، حتى نقدر نقارن كل
    // قطعة لحالها مع سلتك الحقيقية
    const priceWithNames = await safeEvaluate(page, () => {
      const els = Array.from(document.querySelectorAll('[class*="bsc-cart-item-goods-price__sale-price"]'));
      return els.map((el, idx) => {
        let card = el;
        for (let i = 0; i < 5 && card.parentElement; i++) card = card.parentElement;
        const img = card.querySelector("img");
        const altText = img ? img.getAttribute("alt") : null;
        const candidateTexts = Array.from(card.querySelectorAll("*"))
          .map((e) => (e.textContent || "").trim())
          .filter((t) => t.length > 12 && t.length < 140 && !/^\d+\.\d{2}$/.test(t));
        return {
          idx,
          price: el.textContent.trim(),
          altText: altText ? altText.slice(0, 80) : null,
          possibleTitle: candidateTexts[0] ? candidateTexts[0].slice(0, 80) : null,
        };
      });
    });

    // ندور كلمات شائعة تدل على قسم "منتجات مقترحة" منفصل عن السلة
    // الفعلية، حتى نعرف وين بالضبط ينتهي القسم الحقيقي
    const sectionMarkers = await safeEvaluate(page, () => {
      const keywords = [
        "قد يعجبك",
        "مقترح",
        "موصى",
        "مشابه",
        "أضيفي أيضا",
        "أضف أيضا",
        "اكتشف المزيد",
        "You may",
        "Recommend",
        "Also like",
        "Similar",
      ];
      const fullText = document.body.innerText;
      return keywords
        .map((kw) => {
          const idx = fullText.indexOf(kw);
          return idx >= 0 ? { keyword: kw, charIndex: idx } : null;
        })
        .filter(Boolean);
    });

    console.log("📄 عنوان الصفحة:", pageTitle);

    res.json({
      ok: true,
      priceWithNames,
      sectionMarkers,
      startUrl: cartUrl,
      finalUrl,
      shareCode,
      shareCodeSurvived,
      pageTitle,
      bodyTextSample,
      bodyTextTail,
      bodyTextFullLength: bodyTextFull.length,
    });
  } catch (err) {
    console.error("❌ فشل اختبار السلة:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.post("/api/calculate", async (req, res) => {
  const { cartUrl } = req.body || {};
  console.log("🛒 رابط السلة المستلم:", cartUrl);

  if (!cartUrl || typeof cartUrl !== "string" || !/shein\.com/i.test(cartUrl)) {
    console.log("⛔ الرابط مرفوض — ما يحتوي shein.com");
    return res.status(400).json({ error: "رابط السلة غير صحيح، تأكد إنه رابط من شي إن" });
  }

  let browser;
  try {
    console.log("🚀 فاتح المتصفح المخفي...");
    browser = await chromium.launch({ headless: true });
    console.log("✅ المتصفح فتح، جاري تحميل صفحة السلة...");
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "ar-KW",
    });
    const page = await context.newPage();

    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => {
      console.log("⚠️ networkidle ما وصل بالوقت المحدد، نكمل نشوف وين وصلنا:", e.message);
    });
    console.log("✅ الصفحة تحملت، جاري قراءة عناصر السلة...");

    await waitForPricesToAppear(page);
    await autoScroll(page);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);

    // هذا الكلاس (class) مؤكد 100% من فحص فعلي لصفحة سلة حقيقية —
    // يحتوي السعر النهائي (بعد الخصم) لكل قطعة بالضبط، ولا شي غيره.
    // إذا شي إن غيرت تصميم الموقع بالمستقبل وتوقف هذا عن الشغل، شغّل
    // /api/inspect-cart?url=... من جديد على رابط سلة حقيقي وشوف الكلاس
    // الجديد بمكانه.
    const priceTexts = await safeEvaluate(page, () => {
      const els = Array.from(document.querySelectorAll('[class*="bsc-cart-item-goods-price__sale-price"]'));
      return els.map((el) => (el.textContent || "").trim());
    });

    console.log(`📦 لگينا ${priceTexts.length} سعر بالسلة:`, priceTexts);

    if (!priceTexts.length) {
      throw new Error(
        "ما گدرت أگرا أسعار السلة. تأكد إن الرابط عام (مو خاص بحسابك) وجرب مرة ثانية، أو خبرني حتى أفحص الصفحة من جديد."
      );
    }

    let totalIQD = 0;
    let totalCount = 0;
    const breakdown = [];

    for (const text of priceTexts) {
      const priceUSD = parseFloat(String(text).replace(/[^0-9.]/g, "")) || 0;
      if (priceUSD <= 0) continue;

      const qty = 1; // كل سطر بالسلة المشتركة يمثل قطعة وحدة
      const lineIQD = Math.round(priceUSD * USD_TO_IQD) * qty;
      totalIQD += lineIQD;
      totalCount += qty;
      breakdown.push({ priceUSD, qty, lineIQD });
    }

    if (!breakdown.length) {
      throw new Error("لگينا عناصر بالسلة بس ما گدرنا نگرا الأسعار. جرب مرة ثانية أو خبرني بالتفاصيل.");
    }

    res.json({ count: totalCount, totalIQD, breakdown });
  } catch (err) {
    console.error("خطأ بحساب السلة:", err);
    res.status(500).json({ error: err.message || "صار خطأ أثناء قراءة السلة" });
  } finally {
    if (browser) await browser.close();
  }
});

// رابط تشخيص: يفحص بنية الصفحة الحقيقية (أسماء الـ class تبع عناصر
// السعر والكمية) حتى نكتب selectors دقيقة 100% بدل التخمين.
// الاستخدام: /api/inspect-cart?url=رابط_السلة_مرمّز
app.get("/api/inspect-cart", async (req, res) => {
  const cartUrl = req.query.url;
  if (!cartUrl) {
    return res.status(400).json({ error: "ضيف ?url=رابط_السلة بنهاية الرابط" });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ...devices["iPhone 13"], locale: "ar-KW" });
    const page = await context.newPage();

    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
      console.log("⚠️ networkidle ما وصل، نكمل:", e.message);
    });

    const pricesShowedUp = await waitForPricesToAppear(page);
    console.log("💲 ظهرت أسعار بالصفحة؟", pricesShowedUp);

    await autoScroll(page);
    // نعطي فرصة أخيرة للصفحة تستقر قبل ما نبدأ نقرا منها
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1000);

    const priceElements = await safeEvaluate(page, () => {
      const all = Array.from(document.querySelectorAll("body *"));
      const matches = all.filter((el) => {
        const t = (el.textContent || "").trim();
        return /^\d+\.\d{2}$/.test(t) && parseFloat(t) > 0;
      });
      const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
      return deepest.slice(0, 12).map((el) => ({
        text: el.textContent.trim(),
        tag: el.tagName,
        className: el.className,
        parentClassName: el.parentElement ? el.parentElement.className : "",
        grandParentClassName:
          el.parentElement && el.parentElement.parentElement
            ? el.parentElement.parentElement.className
            : "",
      }));
    });

    const qtyElements = await safeEvaluate(page, () => {
      const inputs = Array.from(document.querySelectorAll("input"));
      return inputs
        .filter((inp) => inp.type !== "checkbox" && inp.type !== "radio")
        .slice(0, 10)
        .map((inp) => ({
          type: inp.type,
          value: inp.value,
          className: inp.className,
          name: inp.name,
        }));
    });

    const emAncestorSamples = await safeEvaluate(page, () => {
      const ems = Array.from(document.querySelectorAll("em"));
      const digitEms = ems.filter((el) => /^\d+$/.test((el.textContent || "").trim()));
      const results = [];
      const seen = new Set();
      for (const em of digitEms) {
        let anc = em;
        let hops = 0;
        while (anc && anc.className === "" && hops < 6) {
          anc = anc.parentElement;
          hops++;
        }
        if (!anc) continue;
        const key = anc.className + "|" + anc.tagName;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          emText: em.textContent.trim(),
          ancestorClassName: anc.className,
          ancestorTag: anc.tagName,
          ancestorOuterHTML: anc.outerHTML.slice(0, 1200),
        });
        if (results.length >= 5) break;
      }
      return results;
    });

    const itemContainerSample = await safeEvaluate(page, () => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (!checkbox) return null;
      let anc = checkbox;
      let hops = 0;
      while (anc && hops < 6) {
        anc = anc.parentElement;
        hops++;
      }
      if (!anc) return null;
      return {
        ancestorClassName: anc.className,
        ancestorTag: anc.tagName,
        ancestorOuterHTML: anc.outerHTML.slice(0, 2500),
      };
    });

    res.json({
      ok: true,
      pricesShowedUp,
      priceElements,
      qtyElements,
      emAncestorSamples,
      itemContainerSample,
    });
  } catch (err) {
    console.error("❌ فشل فحص الصفحة:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`سيرفر سما ستور شغال على المنفذ ${PORT}`);
});
