// Сквозной тест сайта в настоящем браузере против локальной копии Supabase.
// Запускается из tests/run.sh (он передаёт SITE, GW, WORK, PSQL_ARGS).
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  for (const name of ["playwright", "/opt/npm-tools/node_modules/playwright"]) {
    try { return require(name); } catch { /* пробуем следующий путь */ }
  }
  console.error("Не найден Playwright: установите его (npm i playwright) или задайте NODE_PATH.");
  process.exit(1);
}

const { chromium } = loadPlaywright();
const SITE = process.env.SITE;
const GW = process.env.GW;
const WORK = process.env.WORK;
const SHOTS = path.join(WORK, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const sql = query => execSync(`psql ${process.env.PSQL_ARGS} -At -c ${JSON.stringify(query)}`).toString().trim();
const debug = () => JSON.parse(execSync(`curl -s ${GW}/__debug`).toString());

const failures = [];
function check(name, condition, detail = "") {
  console.log(`${condition ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(name);
}

(async () => {
  const executablePath = fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
  const browser = await chromium.launch({ executablePath });
  const pageErrors = [];

  async function newPage(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...options });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("dialog", dialog => { pageErrors.push(`неожиданный диалог: ${dialog.message()}`); dialog.dismiss(); });
    await page.route("**/fonts.g*/**", route => route.abort());   // шрифты из интернета в тестах не нужны
    return page;
  }
  const text = async (page, selector) => (await page.textContent(selector) || "").replace(/\s+/g, " ").trim();
  const settle = page => page.waitForTimeout(400);
  const setSliders = async (page, values) => {
    for (const [id, value] of Object.entries(values)) {
      await page.fill(`#${id}`, String(value));
      await page.dispatchEvent(`#${id}`, "input");
    }
  };

  try {
    // ---------- Тестовые картинки и резервная копия старой версии ----------
    const helper = await newPage();
    await helper.goto(SITE);
    const images = await helper.evaluate(() => {
      const draw = (hue, crown) => {
        const canvas = document.createElement("canvas");
        canvas.width = 900; canvas.height = 1200;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = `hsl(${hue}, 20%, 70%)`; ctx.fillRect(0, 0, 900, 1200);
        ctx.fillStyle = "#e8d5c4"; ctx.beginPath(); ctx.ellipse(450, 650, 220, 290, 0, 0, 7); ctx.fill();
        ctx.fillStyle = "#2b1d14"; ctx.beginPath(); ctx.ellipse(450, 480, 260, crown, 0, Math.PI, 0); ctx.fill();
        return canvas.toDataURL("image/jpeg", 0.85);
      };
      return [draw(40, 200), draw(150, 240), draw(220, 180)];
    });
    const photoFile = path.join(WORK, "photo.jpg");
    fs.writeFileSync(photoFile, Buffer.from(images[0].split(",")[1], "base64"));
    const extraFile = path.join(WORK, "extra.jpg");
    fs.writeFileSync(extraFile, Buffer.from(images[1].split(",")[1], "base64"));

    const day = 864e5;
    const old = (a, b, c, d) => ({ accuracy: a, beauty: b, appearance: c, personal: d });
    const backupFile = path.join(WORK, "old-backup.json");
    fs.writeFileSync(backupFile, JSON.stringify({ app: "hairrate", photos: [
      { id: Date.now() - 20 * day, title: "Старый образ", description: "из локальной версии", image: images[2], tags: ["Длинные"],
        reviews: [{ id: Date.now() - 19 * day, author: "Маша", text: "Красиво", ...old(8, 9, 8, 10) }, { id: Date.now() - 18 * day, ...old(5, 5, 5, 5) }] }
    ] }));
    await helper.close();

    // ---------- Гость ----------
    console.log("Гость");
    const guest = await newPage();
    await guest.goto(SITE); await settle(guest);
    check("пустой каталог виден гостю", (await text(guest, ".empty-catalog strong")) === "Каталог пока пуст");
    await guest.goto(SITE + "#/stats"); await settle(guest);
    check("статистика без оценок — пустое состояние", (await text(guest, "#statsBody .empty-catalog strong")) === "Статистики пока нет");
    await guest.goto(SITE); await settle(guest);
    // ---------- Иконка сайта и превью ссылки ----------
    const head = await guest.evaluate(() => {
      const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || "";
      return {
        icon: attr('link[rel="icon"]', "href"), apple: attr('link[rel="apple-touch-icon"]', "href"),
        ogImage: attr('meta[property="og:image"]', "content"), ogTitle: attr('meta[property="og:title"]', "content"),
        ogDescription: attr('meta[property="og:description"]', "content"), card: attr('meta[name="twitter:card"]', "content"),
        themeColors: document.querySelectorAll('meta[name="theme-color"]').length,
      };
    });
    const fetched = await guest.evaluate(async files => Promise.all(files.map(async file => {
      const response = await fetch(file);
      return { ok: response.ok, type: response.headers.get("content-type") || "", body: await response.text() };
    })), [head.icon, head.apple]);
    check("иконка сайта (SVG) отдаётся", fetched[0].ok && fetched[0].type.includes("svg") && fetched[0].body.includes("<svg"), head.icon);
    check("иконка для iPhone отдаётся", fetched[1].ok && fetched[1].type.includes("png"), head.apple);
    const pngSize = file => { const data = fs.readFileSync(path.join(__dirname, "..", file)); return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`; };
    check("иконка для iPhone 180×180", pngSize(head.apple) === "180x180", pngSize(head.apple));
    check("превью ссылки: полный адрес картинки og-image.png 1200×630",
      /^https:\/\/[^/]+\/.*og-image\.png$/.test(head.ogImage) && pngSize("og-image.png") === "1200x630", head.ogImage);
    check("превью ссылки: заголовок, описание, большая карточка, цвет панели в обеих темах",
      head.ogTitle.includes("HairRate") && head.ogDescription.length > 0 && head.card === "summary_large_image" && head.themeColors === 2);

    await guest.click("#openCreateButton"); await settle(guest);
    check("добавление без входа ведёт на вход", (await guest.evaluate(() => location.hash)) === "#/login");

    // ---------- Регистрация и прическа ----------
    console.log("Регистрация, прическа, оценка");
    await guest.click('#authTabs [data-auth="signup"]');
    await guest.fill("#authUsername", "a b"); await guest.fill("#authEmail", "stepan@test.ru"); await guest.fill("#authPassword", "secret123");
    await guest.click("#authSubmit");
    check("неверный ник отклоняется", (await text(guest, "#authError")).startsWith("Ник:"));
    await guest.fill("#authUsername", "Степан"); await guest.click("#authSubmit"); await guest.waitForTimeout(900);
    check("после регистрации — снова к добавлению", (await guest.evaluate(() => location.hash)) === "#/new" && (await text(guest, "#meChip")).includes("Степан"));

    await guest.fill("#newTitle", "Textured Crop");
    await guest.click('#tagPicker [data-tag="Короткие"]');
    await guest.setInputFiles("#newImage", photoFile);
    await guest.setInputFiles("#extraInput", [extraFile]);
    await guest.waitForFunction(() => document.querySelectorAll(".extra-slot").length === 1);
    await guest.waitForSelector("#imagePreview:not(.hidden)");
    await guest.click("#createSubmit");
    await guest.waitForSelector("#detailView:not(.hidden)", { timeout: 15000 });
    const hairId = await guest.evaluate(() => Number(location.hash.split("/")[2]));
    check("прическа создана и открыта", (await text(guest, "#detailTitle")) === "Textured Crop" && (await text(guest, "#detailOwner")).includes("Степан"));
    check("галерея из 2 фото", (await guest.$$eval(".gallery-thumb", items => items.length)) === 2);
    check("фото лежат в хранилище", debug().files.length === 2);

    await guest.click("#openRatingButton"); await settle(guest);
    await setSliders(guest, { accuracy: 7, beauty: 8, appearance: 6, personal: 9 });
    check("живой балл на странице = 55", (await text(guest, "#liveScore")) === "55");
    await guest.click("#reviewSubmit"); await guest.waitForSelector("#detailView:not(.hidden)"); await settle(guest);
    check("балл в базе для 7,8,6,9 = 55", sql(`select score from reviews where hairstyle_id = ${hairId}`) === "55");
    check("кнопка сменилась на «Изменить мою оценку»", (await text(guest, "#openRatingButton")) === "Изменить мою оценку");

    await guest.click("#openRatingButton"); await settle(guest);
    await setSliders(guest, { personal: 10 });
    await guest.fill("#reviewText", "Огонь");
    await guest.click("#reviewSubmit"); await guest.waitForSelector("#detailView:not(.hidden)"); await settle(guest);
    check("правка оценки сохранилась (58) с пометкой", sql(`select score from reviews where hairstyle_id = ${hairId}`) === "58" && (await text(guest, "#reviewsList")).includes("изменено"));

    const [download] = await Promise.all([guest.waitForEvent("download", { timeout: 15000 }), guest.click("#shareHairButton")]);
    check("картинка-карточка скачивается", download.suggestedFilename().endsWith(".png"));

    const sharer = await newPage({ permissions: ["clipboard-read", "clipboard-write"] });
    await sharer.goto(SITE + `#/hair/${hairId}`); await sharer.waitForTimeout(900);
    await sharer.click("#copyLinkButton"); await settle(sharer);
    const copiedLink = await sharer.evaluate(() => navigator.clipboard.readText());
    check("«Ссылка» копирует адрес прически", copiedLink === SITE + `#/hair/${hairId}`, copiedLink);
    check("после копирования видно «Ссылка скопирована»", (await text(sharer, "#toastText")) === "Ссылка скопирована.");
    const opened = await newPage();
    await opened.goto(copiedLink); await opened.waitForTimeout(900);
    check("скопированная ссылка открывает ту же прическу", !(await opened.isHidden("#detailView")) && (await text(opened, "#detailTitle")).length > 0);
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE + `#/hair/${hairId}`); await phone.waitForTimeout(900);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check(`${colorScheme}: страница прически с «Ссылка» без горизонтальной прокрутки`, !overflow && (await phone.isVisible("#copyLinkButton")));
      await phone.screenshot({ path: path.join(SHOTS, `phone-hair-${colorScheme}.png`) });
    }

    // ---------- Второй участник и права ----------
    console.log("Второй участник и права доступа");
    const masha = await newPage();
    await masha.goto(SITE + "#/signup"); await settle(masha);
    await masha.fill("#authUsername", "степан"); await masha.fill("#authEmail", "masha@test.ru"); await masha.fill("#authPassword", "secret123");
    await masha.click("#authSubmit"); await settle(masha);
    check("занятый ник (без учёта регистра) отклоняется", (await text(masha, "#authError")).includes("занят"));
    await masha.fill("#authUsername", "masha_k"); await masha.click("#authSubmit"); await masha.waitForTimeout(900);
    await masha.goto(SITE + `#/hair/${hairId}`); await settle(masha);
    check("чужую прическу нельзя изменить или удалить", !(await masha.isVisible("#editHairButton")) && !(await masha.isVisible("#deleteHairButton")));
    await masha.goto(SITE + `#/hair/${hairId}/edit`); await settle(masha);
    check("прямой адрес правки чужой прически не открывается", (await masha.evaluate(() => location.hash)) === `#/hair/${hairId}`);

    const attacks = await masha.evaluate(async ({ id, gw }) => {
      const session = JSON.parse(localStorage.getItem("hairrate_session"));
      const headers = { apikey: "sb_publishable__TEST", Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Prefer: "return=representation" };
      const post = (url, body) => fetch(`${gw}${url}`, { method: "POST", headers, body: JSON.stringify(body) });
      const patchHair = await fetch(`${gw}/rest/v1/hairstyles?id=eq.${id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "HACKED" }) });
      const first = await post("/rest/v1/reviews", { hairstyle_id: id, accuracy: 9, beauty: 9, appearance: 9, personal: 10 });
      const second = await post("/rest/v1/reviews", { hairstyle_id: id, accuracy: 9, beauty: 9, appearance: 9, personal: 10 });
      const fakeScore = await post("/rest/v1/reviews", { hairstyle_id: id, accuracy: 1, beauty: 1, appearance: 1, personal: 1, score: 67 });
      const fakeArchive = await post("/rest/v1/reviews", { hairstyle_id: id, author: null, legacy_author: "Fake", accuracy: 9, beauty: 9, appearance: 9, personal: 10 });
      const selfAdmin = await fetch(`${gw}/rest/v1/profiles?id=eq.${session.user.id}`, { method: "PATCH", headers, body: JSON.stringify({ is_admin: true }) });
      const selfWearerInsert = await post("/rest/v1/hairstyles", { title: "Моя", images: [`${session.user.id}/x.jpg`], wearer: session.user.id });
      const selfWearerPatch = await fetch(`${gw}/rest/v1/hairstyles?id=eq.${id}`, { method: "PATCH", headers, body: JSON.stringify({ wearer: session.user.id }) });
      return { patchHair: `${patchHair.status}:${await patchHair.text()}`, first: first.status, second: second.status, fakeScore: fakeScore.status, fakeArchive: fakeArchive.status, selfAdmin: selfAdmin.status,
        selfWearerInsert: selfWearerInsert.status, selfWearerPatch: selfWearerPatch.status };
    }, { id: hairId, gw: GW });
    check("правка чужой прически через API не проходит", attacks.patchHair === "200:[]", attacks.patchHair);
    check("первая своя оценка через API проходит", attacks.first === 201, String(attacks.first));
    check("вторая оценка на ту же прическу отклоняется", attacks.second === 409, String(attacks.second));
    check("подделать балл нельзя", attacks.fakeScore >= 400, String(attacks.fakeScore));
    check("архивную оценку без прав админа вставить нельзя", attacks.fakeArchive === 403, String(attacks.fakeArchive));
    check("назначить себя админом нельзя", attacks.selfAdmin === 403, String(attacks.selfAdmin));
    check("title не изменился", sql(`select title from hairstyles where id = ${hairId}`) === "Textured Crop");
    check("стать владельцем своей новой прически через API нельзя", attacks.selfWearerInsert === 403, String(attacks.selfWearerInsert));
    check("стать владельцем чужой прически через API нельзя", attacks.selfWearerPatch >= 400, String(attacks.selfWearerPatch));
    check("владелец прически не назначился", sql("select count(*) from hairstyles where wearer is not null") === "0");

    // ---------- Аккаунт владельца прически (выдаётся в базе) ----------
    console.log("Владелец прически");
    sql(`update hairstyles set wearer = (select id from profiles where username = 'masha_k') where id = ${hairId}`);
    const viewer = await newPage();
    await viewer.goto(SITE + `#/hair/${hairId}`); await viewer.waitForTimeout(900);
    check("на странице прически виден её владелец", (await text(viewer, "#detailOwner")).includes("Владелец прически masha_k"), await text(viewer, "#detailOwner"));
    await viewer.click("#detailOwner .detail-wearer a"); await settle(viewer);
    check("ссылка ведёт в профиль владельца", (await viewer.evaluate(() => location.hash)) === "#/user/masha_k");
    check("в профиле статус «Владелец прически»", await viewer.isVisible("#wearerPill"));
    check("в профиле список его причесок", (await text(viewer, "#wornHairs")).includes("Textured Crop"));
    await viewer.goto(SITE + "#/users"); await settle(viewer);
    check("в списке участников отмечен владелец", (await viewer.$$eval(".user-row", rows => rows.filter(row => row.querySelector(".wearer-mark")).map(row => row.querySelector("strong").textContent))).join() === "masha_k");
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      for (const route of [`#/hair/${hairId}`, "#/user/masha_k"]) {
        await phone.goto(SITE + route); await phone.waitForTimeout(700);
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        check(`${colorScheme}: ${route} с владельцем без горизонтальной прокрутки`, !overflow);
      }
      await phone.screenshot({ path: path.join(SHOTS, `phone-wearer-${colorScheme}.png`), fullPage: true });
    }

    // ---------- Лайки рецензий и лайк владельца прически ----------
    console.log("Лайки рецензий");
    const likeCount = () => sql(`select count(*) from review_likes l join reviews r on r.id = l.review_id where r.hairstyle_id = ${hairId}`);
    await masha.goto(SITE + `#/hair/${hairId}`); await masha.reload(); await masha.waitForTimeout(900);
    check("свою рецензию лайкнуть нельзя (кнопка неактивна)", await masha.isDisabled(".review-card.mine .review-like"));
    await masha.click(".review-card:not(.mine) .review-like"); await masha.waitForTimeout(700);
    check("владелец прически лайкнул рецензию", likeCount() === "1" && (await text(masha, ".review-card:not(.mine) .review-like")) === "♥1");
    check("у рецензии пометка «Нравится владельцу прически»", (await text(masha, ".review-card:not(.mine) .owner-like")).includes("Нравится владельцу прически"));
    await masha.setViewportSize({ width: 1280, height: 500 });
    const likesScrollBefore = await masha.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return window.scrollY; });
    await masha.click(".review-card:not(.mine) .review-like"); await masha.waitForTimeout(700);
    const likesScrollAfter = await masha.evaluate(() => window.scrollY);
    check("повторное нажатие снимает лайк, страница не прыгает наверх", likeCount() === "0" && !(await masha.isVisible(".owner-like")) && likesScrollBefore > 0 && likesScrollAfter > 0, `${likesScrollBefore} → ${likesScrollAfter}`);
    await masha.setViewportSize({ width: 1280, height: 900 });
    await masha.click(".review-card:not(.mine) .review-like"); await masha.waitForTimeout(700);

    await guest.goto(SITE + `#/hair/${hairId}`); await guest.reload(); await guest.waitForTimeout(900);
    check("другие видят лайк владельца", (await text(guest, ".review-card.mine .owner-like")).includes("Нравится владельцу прически"));
    await guest.click(".review-card:not(.mine) .review-like"); await guest.waitForTimeout(700);
    check("обычный лайк участника без пометки владельца", likeCount() === "2" && !(await guest.isVisible(".review-card:not(.mine) .owner-like")));
    await guest.goto(SITE + "#/reviews"); await settle(guest);
    check("лайки видны в ленте", (await guest.$$eval("#feedList .owner-like", items => items.length)) === 1);

    const likeAttacks = await masha.evaluate(async ({ id, gw }) => {
      const session = JSON.parse(localStorage.getItem("hairrate_session"));
      const headers = { apikey: "sb_publishable__TEST", Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Prefer: "return=representation" };
      const reviews = await (await fetch(`${gw}/rest/v1/reviews?hairstyle_id=eq.${id}&select=id,author`, { headers })).json();
      const mine = reviews.find(review => review.author === session.user.id);
      const other = reviews.find(review => review.author !== session.user.id);
      const ownLike = await fetch(`${gw}/rest/v1/review_likes`, { method: "POST", headers, body: JSON.stringify({ review_id: mine.id }) });
      const asOther = await fetch(`${gw}/rest/v1/review_likes`, { method: "POST", headers, body: JSON.stringify({ review_id: other.id, user_id: other.author }) });
      const twice = await fetch(`${gw}/rest/v1/review_likes`, { method: "POST", headers, body: JSON.stringify({ review_id: other.id }) });
      const removeForeign = await fetch(`${gw}/rest/v1/review_likes?review_id=eq.${mine.id}`, { method: "DELETE", headers });
      return { ownLike: ownLike.status, asOther: asOther.status, twice: twice.status, removeForeign: `${removeForeign.status}:${await removeForeign.text()}` };
    }, { id: hairId, gw: GW });
    check("лайк своей рецензии через API отклоняется", likeAttacks.ownLike === 403, String(likeAttacks.ownLike));
    check("лайк от чужого имени через API отклоняется", likeAttacks.asOther === 403, String(likeAttacks.asOther));
    check("второй лайк на ту же рецензию отклоняется", likeAttacks.twice === 409, String(likeAttacks.twice));
    const oldSelect = await viewer.evaluate(async gw => {
      const response = await fetch(`${gw}/rest/v1/hairstyles?select=id,reviews(id,author_profile:profiles(username))`, { headers: { apikey: "sb_publishable__TEST" } });
      return response.status;
    }, GW);
    check("прежний запрос сайта (ники без явной связи) работает с таблицей лайков", oldSelect === 200, String(oldSelect));
    check("чужой лайк снять нельзя", likeAttacks.removeForeign === "200:[]" && likeCount() === "2", likeAttacks.removeForeign);

    await viewer.goto(SITE + `#/hair/${hairId}`); await viewer.reload(); await viewer.waitForTimeout(900);
    check("гость видит число лайков", (await viewer.$$eval(".review-like b", items => items.map(item => item.textContent).sort().join())) === "1,1");
    await viewer.click(".review-like"); await settle(viewer);
    check("лайк без входа ведёт на вход", (await viewer.evaluate(() => location.hash)) === "#/login");
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      for (const route of [`#/hair/${hairId}`, "#/reviews"]) {
        await phone.goto(SITE + route); await phone.waitForTimeout(700);
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        const ownerLikes = await phone.$$eval(".owner-like", items => items.filter(item => item.offsetParent).length);
        check(`${colorScheme}: ${route} с лайками без горизонтальной прокрутки`, !overflow && ownerLikes === 1, `прокрутка: ${overflow}, пометок: ${ownerLikes}`);
      }
      await phone.screenshot({ path: path.join(SHOTS, `phone-likes-${colorScheme}.png`), fullPage: true });
    }

    // ---------- «Новое с прошлого визита» ----------
    console.log("Новое с прошлого визита");
    const hairCreated = Number(sql(`select floor(extract(epoch from created_at) * 1000)::bigint from hairstyles where id = ${hairId}`));
    const markCounts = page => page.evaluate(() => ({
      cards: document.querySelectorAll(".card-new").length,
      marks: [...document.querySelectorAll(".new-mark")].filter(item => item.offsetParent).length
    }));
    const backdateSeen = (page, time) => page.evaluate(value => localStorage.setItem("hairrate_seen", String(value)), time);
    const visitor = await newPage();
    await visitor.goto(SITE); await visitor.waitForTimeout(900);
    let marks = await markCounts(visitor);
    check("первый визит — без меток «новое»", marks.cards === 0 && marks.marks === 0, JSON.stringify(marks));
    const seenStored = Number(await visitor.evaluate(() => localStorage.getItem("hairrate_seen")));
    const newestInDb = Number(sql(`select floor(extract(epoch from max(t)) * 1000)::bigint from (select created_at t from hairstyles union all select created_at from reviews) x`));
    check("сайт запомнил самую новую запись", Math.abs(seenStored - newestInDb) <= 1, `${seenStored} / ${newestInDb}`);

    await backdateSeen(visitor, hairCreated - 1000);
    await visitor.reload(); await visitor.waitForTimeout(900);
    marks = await markCounts(visitor);
    check("прическа после прошлого визита помечена «Новое»", marks.cards === 1 && (await text(visitor, ".card-new")) === "Новое", JSON.stringify(marks));
    await visitor.goto(SITE + "#/reviews"); await settle(visitor);
    marks = await markCounts(visitor);
    check("в ленте новые оценки помечены", marks.marks === 2 && (await text(visitor, "#feedStats")).endsWith("· 2 новые"), `${marks.marks}, ${await text(visitor, "#feedStats")}`);
    await visitor.reload(); await visitor.waitForTimeout(900);
    marks = await markCounts(visitor);
    check("при следующем визите метки исчезают", marks.cards === 0 && marks.marks === 0, JSON.stringify(marks));

    const mashaReviewCreated = Number(sql(`select floor(extract(epoch from r.created_at) * 1000)::bigint from reviews r join profiles p on p.id = r.author where p.username = 'masha_k' and r.hairstyle_id = ${hairId}`));
    await backdateSeen(visitor, mashaReviewCreated - 1);
    await visitor.goto(SITE); await visitor.reload(); await visitor.waitForTimeout(900);
    marks = await markCounts(visitor);
    check("на карточке с новой оценкой — «+1 новая»", marks.cards === 0 && (await text(visitor, ".hair-card .card-fresh")) === "+1 новая", await text(visitor, ".hair-card .card-meta"));

    await backdateSeen(masha, hairCreated - 1000);
    await masha.goto(SITE + `#/hair/${hairId}`); await masha.reload(); await masha.waitForTimeout(900);
    check("свою оценку участник не видит как новую", (await masha.$$eval(".review-card.mine .new-mark", items => items.length)) === 0 && (await masha.$$eval(".review-card:not(.mine) .new-mark", items => items.length)) === 1);
    await guest.reload(); await guest.waitForTimeout(900);
    await backdateSeen(guest, hairCreated - 1000);
    await guest.goto(SITE); await guest.reload(); await guest.waitForTimeout(900);
    check("свою прическу автор не видит как новую", (await guest.$$eval(".card-new", items => items.length)) === 0 && (await text(guest, ".hair-card .card-fresh")) === "+1 новая");

    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE); await phone.waitForTimeout(700);
      for (const route of ["#/", "#/reviews"]) {
        await backdateSeen(phone, hairCreated - 1000);
        await phone.goto(SITE + route); await phone.reload(); await phone.waitForTimeout(700);
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        const shown = await markCounts(phone);
        check(`${colorScheme}: ${route} с метками «новое» без горизонтальной прокрутки`, !overflow && shown.cards + shown.marks > 0, `прокрутка: ${overflow}, меток: ${JSON.stringify(shown)}`);
        await phone.screenshot({ path: path.join(SHOTS, `phone-new-${route === "#/" ? "catalog" : "feed"}-${colorScheme}.png`) });
      }
    }

    // ---------- Админ: удаление чужой оценки и перенос старой копии ----------
    console.log("Админ");
    sql("update profiles set is_admin = true where username = 'masha_k'");
    await masha.reload(); await masha.waitForTimeout(900);
    check("админ видит удаление чужой прически", await masha.isVisible("#deleteHairButton"));
    const foreignDelete = await masha.$(".review-card:not(.mine) .review-delete");
    await foreignDelete.click();
    check("удаление просит второе нажатие", (await foreignDelete.textContent()).includes("Удалить?"));
    await foreignDelete.click(); await masha.waitForTimeout(900);
    check("админ удалил чужую оценку", sql(`select count(*) from reviews where hairstyle_id = ${hairId}`) === "1");

    const waitImport = () => masha.waitForFunction(() => /^(Готово|Перенос прерван)/.test(document.getElementById("toastText").textContent), null, { timeout: 60000 });
    await masha.setInputFiles("#importInput", backupFile); await waitImport();
    check("перенос из старой копии: прическа и архивные оценки", sql("select count(*) from hairstyles where title = 'Старый образ'") === "1" && sql("select count(*) from reviews where author is null") === "2", await text(masha, "#toastText"));
    check("даты из старой версии сохранились", sql("select created_at < now() - interval '10 days' from hairstyles where title = 'Старый образ'") === "t");
    await masha.evaluate(() => { document.getElementById("toastText").textContent = ""; });
    await masha.setInputFiles("#importInput", backupFile); await waitImport();
    check("повторный перенос ничего не задваивает", sql("select count(*) from hairstyles where title = 'Старый образ'") === "1" && sql("select count(*) from reviews where author is null") === "2");
    await masha.goto(SITE + "#/users"); await settle(masha);
    const members = await masha.$$eval(".user-row strong", items => items.map(item => item.textContent));
    check("архивные ники не попадают в участники", !members.some(name => name.startsWith("Маша")), members.join(", "));

    // ---------- Смена ника ----------
    console.log("Смена ника");
    const stepanId = sql("select id from profiles where username = 'Степан'");
    const mashaId = sql("select id from profiles where username = 'masha_k'");
    const stepanStuff = () => sql(`select (select count(*) from reviews where author = '${stepanId}') || '/' || (select count(*) from hairstyles where owner = '${stepanId}')`);
    const stuffBefore = stepanStuff();
    await guest.goto(SITE + "#/user/masha_k"); await guest.reload(); await guest.waitForTimeout(900);
    check("в чужом профиле нет «Сменить ник»", !(await guest.$("#renameButton")));
    await guest.goto(SITE + `#/user/${encodeURIComponent("Степан")}`); await settle(guest);
    check("в своём профиле есть «Сменить ник», форма скрыта", await guest.isVisible("#renameButton") && !(await guest.isVisible("#renameForm")));
    await guest.click("#renameButton");
    check("форма открывается с текущим ником", await guest.isVisible("#renameForm") && (await guest.inputValue("#renameInput")) === "Степан");
    await guest.press("#renameInput", "Escape");
    check("Escape закрывает форму", !(await guest.isVisible("#renameForm")));
    await guest.click("#renameButton");
    await guest.fill("#renameInput", "a b"); await guest.click("#renameSubmit"); await settle(guest);
    check("неверный ник отклоняется", (await text(guest, "#renameError")).startsWith("Ник:"));
    await guest.fill("#renameInput", "MASHA_K"); await guest.click("#renameSubmit"); await settle(guest);
    check("занятый ник (в другом регистре) отклоняется", (await text(guest, "#renameError")).includes("занят") && sql(`select username from profiles where id = '${stepanId}'`) === "Степан");
    const bypass = await guest.evaluate(async ({ mashaId, stepanId }) => {
      const out = {};
      try { out.foreign = (await rest(`profiles?id=eq.${mashaId}&select=id`, { method: "PATCH", body: { username: "hacked" }, headers: { Prefer: "return=representation" } })).length; }
      catch (error) { out.foreign = `ошибка ${error.status}`; }
      try { await rest(`profiles?id=eq.${stepanId}&select=id`, { method: "PATCH", body: { is_admin: true }, headers: { Prefer: "return=representation" } }); out.admin = "прошло"; }
      catch (error) { out.admin = `ошибка ${error.status}`; }
      try { await rest(`profiles?id=eq.${stepanId}&select=id`, { method: "PATCH", body: { username: "masha_K" }, headers: { Prefer: "return=representation" } }); out.dup = "прошло"; }
      catch (error) { out.dup = error.code; }
      return out;
    }, { mashaId, stepanId });
    check("через API чужой ник не поменять", bypass.foreign === 0 && sql(`select username from profiles where id = '${mashaId}'`) === "masha_k", JSON.stringify(bypass));
    check("через API себе админа не выдать", bypass.admin !== "прошло" && sql(`select is_admin from profiles where id = '${stepanId}'`) === "f", JSON.stringify(bypass));
    check("через API занятый ник не взять", bypass.dup === "23505", JSON.stringify(bypass));
    await guest.fill("#renameInput", "Stepan_S"); await guest.click("#renameSubmit"); await guest.waitForTimeout(900);
    check("ник сменён в базе", sql(`select username from profiles where id = '${stepanId}'`) === "Stepan_S");
    check("после смены — профиль по новому адресу, ник в шапке",
      (await guest.evaluate(() => location.hash)) === "#/user/Stepan_S" && (await text(guest, "#userProfile h2")) === "Stepan_S" &&
      (await text(guest, "#meChip")).includes("Stepan_S") && !(await guest.isVisible("#renameForm")), await guest.evaluate(() => location.hash));
    check("уведомление о смене ника", (await text(guest, "#toastText")).includes("Stepan_S"));
    check("оценки и прически остались за участником", stepanStuff() === stuffBefore && !stuffBefore.endsWith("/0"), `${stuffBefore} → ${stepanStuff()}`);
    await guest.goto(SITE + `#/hair/${hairId}`); await settle(guest);
    check("на странице прически — новый ник", (await text(guest, "#detailOwner")).includes("Stepan_S") && !(await text(guest, "#detailOwner")).includes("Степан"), await text(guest, "#detailOwner"));
    await guest.goto(SITE + `#/user/${encodeURIComponent("Степан")}`); await settle(guest);
    check("старый адрес профиля ведёт к участникам", (await guest.evaluate(() => location.hash)) === "#/users");
    await guest.goto(SITE + "#/user/Stepan_S"); await settle(guest);
    await guest.click("#renameButton");
    await guest.fill("#renameInput", "stepan_s"); await guest.click("#renameSubmit"); await guest.waitForTimeout(900);
    check("можно сменить только регистр своего ника", sql(`select username from profiles where id = '${stepanId}'`) === "stepan_s" && (await guest.evaluate(() => location.hash)) === "#/user/stepan_s");
    const stepanSession = await guest.evaluate(() => localStorage.getItem("hairrate_session"));
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE);
      await phone.evaluate(value => { if (value) localStorage.setItem("hairrate_session", value); }, stepanSession);
      await phone.goto(SITE + "#/user/stepan_s"); await phone.reload(); await phone.waitForTimeout(900);
      await phone.click("#renameButton");
      await phone.fill("#renameInput", "x"); await phone.click("#renameSubmit"); await settle(phone);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check(`${colorScheme}: смена ника на телефоне без горизонтальной прокрутки`, !overflow && await phone.isVisible("#renameError"), `прокрутка: ${overflow}`);
      await phone.screenshot({ path: path.join(SHOTS, `phone-rename-${colorScheme}.png`) });
    }

    // ---------- Удаление своей прически ----------
    console.log("Удаление");
    await guest.goto(SITE + `#/hair/${hairId}`); await guest.reload(); await guest.waitForTimeout(900);
    await guest.click("#deleteHairButton"); await guest.click("#deleteHairButton"); await guest.waitForTimeout(900);
    check("владелец удалил прическу", sql(`select count(*) from hairstyles where id = ${hairId}`) === "0" && (await guest.evaluate(() => location.hash)) === "#/");

    // ---------- «Показать ещё» в каталоге и ленте ----------
    console.log("Показать ещё");
    sql("insert into hairstyles (owner, title, images, created_at) " +
        `select '${stepanId}', 'Пачка ' || n, (select images from hairstyles order by id limit 1), now() - interval '3 days' - n * interval '1 minute' from generate_series(1, 30) n`);
    sql("insert into reviews (hairstyle_id, legacy_author, text, accuracy, beauty, appearance, personal, created_at) " +
        "select h.id, 'Гость ' || k, case when k = 1 then 'Текст пачки' else '' end, 5, 6, 7, 8, h.created_at + k * interval '1 second' " +
        "from hairstyles h, generate_series(1, 2) k where h.title like 'Пачка %'");
    const totalHair = Number(sql("select count(*) from hairstyles"));
    const totalReviews = Number(sql("select count(*) from reviews"));
    const textReviews = Number(sql("select count(*) from reviews where text <> ''"));
    const cards = page => page.$$eval("#hairGrid .hair-card", items => items.length);
    const feedCards = page => page.$$eval("#feedList .review-card", items => items.length);
    await guest.goto(SITE); await guest.reload(); await guest.waitForTimeout(900);
    check("каталог: сначала 24 прически и кнопка «Показать ещё»",
      (await cards(guest)) === 24 && await guest.isVisible("#catalogMore .more-button") &&
      (await text(guest, "#catalogMore")).includes(`Показано 24 из ${totalHair}`), `${await cards(guest)} · ${await text(guest, "#catalogMore")}`);
    await guest.click("#catalogMore .more-button"); await settle(guest);
    check("каталог: «Показать ещё» добавляет следующие",
      (await cards(guest)) === Math.min(48, totalHair) && (await guest.isVisible("#catalogMore")) === totalHair > 48, String(await cards(guest)));
    await guest.click("#hairGrid .hair-card >> nth=30"); await settle(guest);
    await guest.goBack(); await settle(guest);
    check("каталог: после возврата со страницы прически показано столько же", (await cards(guest)) === Math.min(48, totalHair), String(await cards(guest)));
    await guest.fill("#searchInput", "Пачка"); await settle(guest);
    check("каталог: поиск начинает список заново",
      (await cards(guest)) === 24 && (await text(guest, "#catalogMore")).includes("Показано 24 из 30"), await text(guest, "#catalogMore"));
    await guest.fill("#searchInput", "Пачка 1"); await settle(guest);
    check("каталог: когда всё показано, кнопки нет", (await cards(guest)) === 11 && !(await guest.isVisible("#catalogMore")), String(await cards(guest)));
    await guest.fill("#searchInput", ""); await settle(guest);
    await guest.goto(SITE + "#/reviews"); await settle(guest);
    check("лента: сначала 30 оценок и кнопка «Показать ещё»",
      (await feedCards(guest)) === 30 && (await text(guest, "#feedMore")).includes(`Показано 30 из ${totalReviews}`), `${await feedCards(guest)} · ${await text(guest, "#feedMore")}`);
    await guest.click("#feedMore .more-button"); await settle(guest);
    check("лента: «Показать ещё» добавляет следующие",
      (await feedCards(guest)) === Math.min(60, totalReviews) && (await guest.evaluate(() => document.activeElement?.classList.contains("more-button") || !document.querySelector("#feedMore .more-button"))),
      String(await feedCards(guest)));
    await guest.click("#feedView label.toggle"); await settle(guest);
    check("лента: фильтр «Только с текстом» начинает список заново",
      (await feedCards(guest)) === Math.min(30, textReviews) && (await guest.isVisible("#feedMore")) === textReviews > 30, `${await feedCards(guest)} из ${textReviews}`);
    await guest.click("#feedView label.toggle"); await settle(guest);
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE); await phone.waitForTimeout(900);
      await phone.locator("#catalogMore .more-button").scrollIntoViewIfNeeded();
      const box = await phone.locator("#catalogMore .more-button").boundingBox();
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check(`${colorScheme}: «Показать ещё» на телефоне помещается без горизонтальной прокрутки`, !overflow && box && box.x >= 0 && box.x + box.width <= 375, `прокрутка: ${overflow}`);
      await phone.screenshot({ path: path.join(SHOTS, `phone-more-${colorScheme}.png`) });
      await phone.goto(SITE + "#/reviews"); await phone.waitForTimeout(500);
      check(`${colorScheme}: лента с «Показать ещё» на телефоне`, await phone.isVisible("#feedMore .more-button") && !(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    }

    // ---------- Статистика ----------
    console.log("Статистика");
    const packId = n => sql(`select id from hairstyles where title = 'Пачка ${n}'`);
    sql(`insert into reviews (hairstyle_id, author, text, accuracy, beauty, appearance, personal) values ` +
        `(${packId(1)}, '${stepanId}', 'Отлично', 9, 9, 9, 10), (${packId(2)}, '${stepanId}', '', 1, 1, 1, 1), ` +
        `(${packId(1)}, '${mashaId}', '', 1, 1, 1, 1)`);
    const stepanName = sql(`select username from profiles where id = '${stepanId}'`);
    const verdictCounts = sql("select count(*) filter (where score >= 60) || ',' || count(*) filter (where score >= 50 and score < 60) || ',' || " +
      "count(*) filter (where score >= 40 and score < 50) || ',' || count(*) filter (where score >= 30 and score < 40) || ',' || " +
      "count(*) filter (where score >= 20 and score < 30) || ',' || count(*) filter (where score < 20) from reviews");
    const mostDisputed = sql("select h.title from hairstyles h join reviews r on r.hairstyle_id = h.id group by h.id " +
      "having count(*) >= 2 and max(r.score) > min(r.score) order by stddev_pop(r.score) desc, max(r.score) - min(r.score) desc, count(*) desc, h.created_at desc limit 1");
    await guest.goto(SITE); await guest.reload(); await guest.waitForTimeout(900);
    await guest.click('#mainNav a[data-nav="stats"]'); await settle(guest);
    check("раздел «Статистика» открывается из меню", (await guest.evaluate(() => location.hash)) === "#/stats" &&
      !(await guest.isHidden("#statsView")) && (await text(guest, '#mainNav a.active')) === "Статистика");
    const tiles = await guest.$$eval("#statsTiles .stat-tile strong", items => items.map(item => item.textContent.replace(/\s+/g, " ").trim()));
    check("сводка: число причесок, оценок и участников",
      tiles[0] === sql("select count(*) from hairstyles") && tiles[1].startsWith(sql("select count(*) from reviews")) &&
      tiles[1].endsWith(`${sql("select count(*) from reviews where text <> ''")} с текстом`) && tiles[2] === sql("select count(*) from profiles"), tiles.join(" | "));
    const shownCounts = await guest.$$eval("#verdictStats .verdict-stat strong", items => items.map(item => item.firstChild.textContent.trim()).join(","));
    check("распределение по вердиктам совпадает с базой", shownCounts === verdictCounts, `${shownCounts} / ${verdictCounts}`);
    const labels = await guest.$$eval("#verdictStats .criterion-top span", items => items.map(item => item.textContent.replace(/\s+/g, " ").trim()).join("; "));
    check("вердикты по порядку с диапазонами баллов", labels.startsWith("Шедевр 60–67; Отлично 50–59") && labels.endsWith("Провал 4–19"), labels);
    const active = await guest.$$eval("#activeMembers .user-row strong", items => items.map(item => item.textContent.replace(" (вы)", "").trim()));
    check("самые активные: по числу оценок", active[0] === stepanName && active[1] === "masha_k" && active.length === 2, active.join(", "));
    check("у активного участника видно число оценок и с текстом", (await text(guest, "#activeMembers .user-row small")).startsWith("2 оценки · 1 с текстом"), await text(guest, "#activeMembers .user-row small"));
    const disputed = await text(guest, "#controversialList .top-row strong");
    check("самый спорный образ — с наибольшим разбросом", disputed === mostDisputed && (await text(guest, "#controversialList .top-row small")).includes("разброс ±"), `${disputed} / ${mostDisputed}`);
    await guest.click("#controversialList .top-row"); await settle(guest);
    check("из статистики можно перейти к прическе", (await text(guest, "#detailTitle")) === mostDisputed);
    await guest.goto(SITE + "#/stats"); await settle(guest);
    await guest.click("#activeMembers .user-row"); await settle(guest);
    check("из статистики можно перейти в профиль", (await guest.evaluate(() => decodeURIComponent(location.hash))) === `#/user/${stepanName}`);
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE + "#/stats"); await phone.waitForTimeout(900);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      const bars = await phone.$$eval("#verdictStats .criterion-bar", items => items.every(item => item.getBoundingClientRect().right <= window.innerWidth));
      check(`${colorScheme}: статистика на телефоне без горизонтальной прокрутки`, !overflow && bars, `прокрутка: ${overflow}`);
      const navVisible = await phone.evaluate(() => {
        const nav = document.getElementById("mainNav").getBoundingClientRect();
        const link = document.querySelector('#mainNav a[data-nav="stats"]').getBoundingClientRect();
        return link.left >= nav.left - 1 && link.right <= nav.right + 1;
      });
      check(`${colorScheme}: пункт «Статистика» в меню виден на телефоне целиком`, navVisible);
      await phone.screenshot({ path: path.join(SHOTS, `phone-stats-${colorScheme}.png`), fullPage: true });
    }
    await guest.screenshot({ path: path.join(SHOTS, "desktop-stats.png"), fullPage: true });

    // ---------- Вёрстка на телефоне ----------
    console.log("Телефон, обе темы");
    for (const colorScheme of ["light", "dark"]) {
      const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      await phone.goto(SITE); await settle(phone);
      for (const route of ["#/", "#/top", "#/reviews", "#/users", "#/compare", "#/stats", "#/login"]) {
        await phone.goto(SITE + route); await phone.waitForTimeout(350);
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        check(`${colorScheme}: ${route} без горизонтальной прокрутки`, !overflow);
      }
      await phone.goto(SITE); await phone.waitForTimeout(500);
      await phone.screenshot({ path: path.join(SHOTS, `phone-${colorScheme}.png`), fullPage: true });
    }
    await guest.setViewportSize({ width: 1280, height: 900 });
    await guest.goto(SITE); await guest.waitForTimeout(500);
    await guest.screenshot({ path: path.join(SHOTS, "desktop-catalog.png"), fullPage: true });

    // ---------- Старая схема базы (без колонки wearer) ----------
    console.log("Старая схема базы");
    sql("alter table hairstyles drop column wearer cascade");
    const legacy = await newPage();
    await legacy.goto(SITE); await legacy.waitForTimeout(900);
    check("без колонки wearer каталог загружается", (await legacy.$$eval(".hair-card", cards => cards.length)) >= 1);
    await legacy.goto(SITE + "#/user/masha_k"); await settle(legacy);
    check("без колонки wearer профиль открывается без статуса владельца", (await text(legacy, "#userProfile")).includes("masha_k") && !(await legacy.isVisible("#wearerPill")));
    sql("drop table review_likes");
    await legacy.goto(SITE); await legacy.reload(); await legacy.waitForTimeout(900);
    check("без таблицы лайков каталог загружается", (await legacy.$$eval(".hair-card", cards => cards.length)) >= 1);
    sql("notify pgrst, 'reload schema'"); await legacy.waitForTimeout(1000);
    await legacy.goto(SITE + "#/reviews"); await legacy.reload(); await legacy.waitForTimeout(900);
    check("без таблицы лайков лента без кнопок лайка", (await legacy.$$eval("#feedList .review-card", cards => cards.length)) >= 1 && (await legacy.$$eval(".review-like", items => items.length)) === 0);
    await legacy.goto(SITE + "#/stats"); await settle(legacy);
    check("старая схема: статистика открывается", (await legacy.$$eval("#verdictStats .verdict-stat", items => items.length)) === 6);

    check("нет ошибок JavaScript на страницах", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (error) {
    failures.push(`тест упал: ${error.message}`);
    console.error(error);
  } finally {
    await browser.close();
  }

  console.log(`\nСкриншоты: ${SHOTS}`);
  if (failures.length) {
    console.error(`\nНЕ ПРОШЛО: ${failures.length}\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nВсе проверки сайта пройдены.");
})();
