// سيرفر سما ستور — يقرا سلة شي إن (الموقع الكويتي) ويحسب السعر بالدينار العراقي
//
// كيف يشتغل:
//   1) الواجهة (index.html) ترسل رابط السلة إلى POST /api/calculate
//   2) السيرفر يفتح الرابط بمتصفح مخفي (Playwright/Chromium)
//   3) يقرا سعر كل قطعة بالدولار من صفحة السلة، يضربها × USD_TO_IQD
//   4) يرجع مجموع السلة كامل + عدد القطع
//
// ⚠️ ملاحظة مهمة: ما گدرت أختبر هذا الكود على موقع شي إن الحقيقي لأن بيئتي
// هنا ما عندها اتصال إنترنت. الـ selectors (أسماء العناصر) تحتها مبنية على
// البنية الشائعة لصفحات سلة شي إن، لكن شي إن تغيّر تصميم موقعها بين فترة
// وأخرى. إذا شغلت السيرفر وطلعت له أخطاء أو أرقام غلط، افتح صفحة السلة
// بالمتصفح، اضغط F12 > Elements، وابعثلي شكل الـ HTML تبع عنصر السعر
// وعنصر الكمية حتى أعدل الـ selectors بدقة. الأقسام اللي تحتاج تعديل
// محددة بعلامة "TODO" تحت.

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
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log("📍 الرابط النهائي بعد التحويلات:", finalUrl);

    const pageTitle = await page.title();
    const htmlContent = await page.content();

    // نتأكد هل رمز مشاركة السلة انحفظ وياه لحد الصفحة النهائية أو لا
    const shareCodeMatch = cartUrl.match(/shc=([^&]+)/);
    const shareCode = shareCodeMatch ? shareCodeMatch[1] : null;
    const shareCodeSurvived = shareCode ? htmlContent.includes(shareCode) : null;

    const bodyTextSample = await page.evaluate(() => document.body.innerText.slice(0, 1500));

    console.log("📄 عنوان الصفحة:", pageTitle);
    console.log("🔑 رمز السلة نجا؟", shareCodeSurvived);

    res.json({
      ok: true,
      startUrl: cartUrl,
      finalUrl,
      shareCode,
      shareCodeSurvived,
      pageTitle,
      bodyTextSample,
      note: "finalUrl يوريك وين وصلت الصفحة فعلياً بعد أي تحويل تلقائي. إذا finalUrl يختلف كلياً عن الرابط الأصلي ورجع لصفحة عامة، ورمز السلة (shareCodeSurvived) طلع false، معناها الرابط يحتاج يفتح داخل تطبيق شي إن نفسه ومستحيل نقرا السلة منه بمتصفح عادي.",
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
      locale: "ar-KW",
      // TODO: إذا الرابط ما يفتح على نسخة الكويت (kw) تلقائياً، جرب تبدل
      // الدومين يدوياً هنا قبل الفتح، مثلاً استبدال "shein.com" بـ
      // "shein.com/kw" أو إضافة كوكي المنطقة قبل goto.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.goto(cartUrl, { waitUntil: "networkidle", timeout: 45000 });
    console.log("✅ الصفحة تحملت، جاري قراءة عناصر السلة...");
    // نعطي الصفحة وقت إضافي حتى تحمّل عناصر السلة بالكامل (تحميل كسول/JS)
    await page.waitForTimeout(3000);

    // TODO: هذا الـ selector يمثل "بطاقة" كل قطعة داخل السلة. جرب هذي
    // الاحتمالات المعروفة لصفحات شي إن، وإذا ولا وحدة اشتغلت ابعثلي
    // الـ HTML الفعلي:
    const ITEM_SELECTORS = [
      ".cart-item",
      ".j-cart-item",
      "[class*='cartItem']",
      "[class*='cart-list__item']",
      "[class*='goods-item']",
    ];

    let items = [];
    for (const sel of ITEM_SELECTORS) {
      const found = await page.$$eval(sel, (nodes) =>
        nodes.map((node) => {
          const priceEl =
            node.querySelector("[class*='price']:not([class*='origin']):not([class*='del'])") ||
            node.querySelector("[class*='price']");
          const qtyEl =
            node.querySelector("input[class*='num']") ||
            node.querySelector("[class*='qty']") ||
            node.querySelector("[class*='quantity']");

          const priceText = priceEl ? priceEl.textContent : "";
          const qtyRaw = qtyEl ? qtyEl.value ?? qtyEl.textContent : "1";

          return { priceText: (priceText || "").trim(), qtyRaw: (qtyRaw || "1").trim() };
        })
      );

      if (found.length) {
        items = found;
        break;
      }
    }

    if (!items.length) {
      throw new Error(
        "ما گدرت أگرا محتوى السلة. تأكد إن الرابط عام (مو خاص بحسابك) وجرب مرة ثانية، أو خبرني بشكل صفحة السلة حتى أعدل السيرفر."
      );
    }

    let totalIQD = 0;
    let totalCount = 0;
    const breakdown = [];

    for (const { priceText, qtyRaw } of items) {
      const priceUSD = parseFloat(String(priceText).replace(/[^0-9.]/g, "")) || 0;
      const qty = parseInt(String(qtyRaw).replace(/[^0-9]/g, ""), 10) || 1;

      if (priceUSD <= 0) continue; // تجاهل أي عنصر ما گدرنا نگرا سعره

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

app.listen(PORT, () => {
  console.log(`سيرفر سما ستور شغال على المنفذ ${PORT}`);
});
