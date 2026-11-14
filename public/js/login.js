// public/js/login.js
import { getUserByLineId, insertAuditLog } from "./firestore.js";

// ============================================================================
// 🎯 [ตั้งค่าระบบ & สวิตช์โหมดทดสอบ]
// ============================================================================
const IS_DEV_MODE = false; // true = เปิดช่องกรอก LINE User ID ทดสอบ | false = บังคับ LINE Login จริง

const DEV_DEFAULT_LINE_ID = "Ub1c1cb6c91bee88632afa055e2a98fcd";

const LINE_CONFIG = {
  channelId: "2010270196",
  redirectUri: window.location.origin + window.location.pathname
};

// กำหนดข้อมูลและหน้าปลายทางของแต่ละระบบ
const SYSTEM_CONFIG = {
  "back-office": {
    label: "ระบบหลังบ้าน",
    title: "🔒 ระบบหลังบ้าน Atom Group Phi Phi",
    badgeClass: "bg-primary",
    redirectUrl: "back-office/index.html"
  },
  "hr": {
    label: "ระบบ HR",
    title: "👥 ระบบ HR Atom Group Phi Phi",
    badgeClass: "bg-success",
    redirectUrl: "hr/index.html"
  }
};

let currentTargetSystem = "back-office";

// ============================================================================
// 🚀 เริ่มทำงานเมื่อโหลดหน้าเว็บ
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (IS_DEV_MODE) {
    document.getElementById("devModeSection").classList.remove("d-none");
    document.getElementById("devLineIdInput").value = DEV_DEFAULT_LINE_ID;
  }

  document.getElementById("btnLineLogin").addEventListener("click", redirectToLineLogin);
  document.getElementById("btnDevLogin").addEventListener("click", handleDevLogin);
  document.getElementById("devLineIdInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleDevLogin();
  });

  // 1. ตรวจสอบว่ามีการ Redirect กลับมาจาก LINE (?code=...) หรือไม่
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");

  if (code) {
    const savedSystem = sessionStorage.getItem("atom_selected_system") || "back-office";
    selectTargetSystem(savedSystem);
    await handleLineCallback(code, state);
    return;
  }

  // 2. กรณีเปิดผ่านลิงก์ตรงเช่น login.html?system=hr หรือ login.html?system=back-office
  const systemParam = urlParams.get("system");
  if (systemParam && SYSTEM_CONFIG[systemParam]) {
    selectTargetSystem(systemParam);
  }
});

// ============================================================================
// 🧭 0. สลับหน้าเลือกระบบ <-> หน้า Login ของระบบนั้น
// ============================================================================
function selectTargetSystem(systemKey) {
  if (!SYSTEM_CONFIG[systemKey]) return;

  currentTargetSystem = systemKey;
  sessionStorage.setItem("atom_selected_system", systemKey);

  const cfg = SYSTEM_CONFIG[systemKey];
  const badgeEl = document.getElementById("selectedSystemBadge");
  const titleEl = document.getElementById("loginSystemTitle");

  if (badgeEl) {
    badgeEl.className = `badge ${cfg.badgeClass} px-3 py-2`;
    badgeEl.textContent = cfg.label;
  }
  if (titleEl) {
    titleEl.textContent = cfg.title;
  }

  document.getElementById("systemSelectSection").classList.add("d-none");
  document.getElementById("noAccessSection").classList.add("d-none");
  document.getElementById("loginSection").classList.remove("d-none");
}

function backToSystemSelect() {
  sessionStorage.removeItem("atom_selected_system");
  document.getElementById("loginSection").classList.add("d-none");
  document.getElementById("noAccessSection").classList.add("d-none");
  document.getElementById("systemSelectSection").classList.remove("d-none");
}

// ============================================================================
// 🛠️ 1. ฟังก์ชันเข้าสู่ระบบผ่าน DEV MODE (เช็ค Collection /users/{id} จริง)
// ============================================================================
async function handleDevLogin() {
  const inputId = document.getElementById("devLineIdInput").value.trim();
  if (!inputId) {
    alert("กรุณากรอก LINE User ID ก่อนครับ");
    return;
  }

  const sysCfg = SYSTEM_CONFIG[currentTargetSystem];
  setLoading(true, `กำลังตรวจสอบสิทธิ์${sysCfg.label} (ID: ${inputId})...`);

  try {
    const userAccess = await getUserByLineId(inputId);

    if (!userAccess) {
      showNoAccessScreen({
        id: inputId,
        name: "Dev Test User (ไม่พบข้อมูลในระบบ)",
        picture: "https://cdn-icons-png.flaticon.com/512/149/149071.png"
      });
      return;
    }

    const accessCheck = checkSystemPermission(userAccess, currentTargetSystem);
    if (!accessCheck.allowed) {
      showNoAccessScreen({
        id: inputId,
        name: userAccess.name || "Dev_User",
        picture: "https://cdn-icons-png.flaticon.com/512/149/149071.png"
      }, accessCheck.reason);
      return;
    }

    const lineUserObj = {
      id: inputId,
      name: userAccess.name || "Dev_User",
      picture: "https://cdn-icons-png.flaticon.com/512/149/149071.png",
      role: userAccess.role,
      allowedOptions: userAccess.allowedOptions || [],
      targetSystem: currentTargetSystem,
      isDevMode: true
    };

    const logDetail = currentTargetSystem === "hr"
      ? `เข้าสู่ระบบ HR ผ่าน Dev Mode สำเร็จ (User: ${lineUserObj.name})`
      : `เข้าสู่ระบบหลังบ้านผ่าน Dev Mode สำเร็จ (User: ${lineUserObj.name}, Role: ${userAccess.role})`;

    await insertAuditLog("LOGIN_DEV", logDetail, lineUserObj);

    completeLoginAndRedirect(lineUserObj);

  } catch (error) {
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อ Firestore: " + error.message);
  } finally {
    setLoading(false);
  }
}

// ============================================================================
// 🟢 2. ฟังก์ชัน LINE Login OAuth2 + PKCE (เชื่อมต่อ LINE API โดยตรง)
// ============================================================================
function generateCodeVerifier(length = 64) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (v) => charset[v % charset.length]).join("");
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function redirectToLineLogin() {
  sessionStorage.setItem("atom_selected_system", currentTargetSystem);

  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  sessionStorage.setItem("line_oauth_state", state);
  sessionStorage.setItem("line_code_verifier", codeVerifier);

  const authUrl = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", LINE_CONFIG.channelId);
  authUrl.searchParams.set("redirect_uri", LINE_CONFIG.redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "profile openid");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  window.location.href = authUrl.toString();
}

async function handleLineCallback(code, returnedState) {
  const sysCfg = SYSTEM_CONFIG[currentTargetSystem];
  setLoading(true, `กำลังยืนยันตัวตนเข้าสู่${sysCfg.label}...`);
  window.history.replaceState({}, document.title, window.location.pathname);

  try {
    const savedState = sessionStorage.getItem("line_oauth_state");
    const codeVerifier = sessionStorage.getItem("line_code_verifier");
    sessionStorage.removeItem("line_oauth_state");
    sessionStorage.removeItem("line_code_verifier");

    if (savedState && returnedState !== savedState) {
      throw new Error("State ไม่ตรงกัน (อาจเกิดจาก CSRF หรือ Session หมดอายุ)");
    }

    if (!codeVerifier) {
      throw new Error("ไม่พบข้อมูลยืนยัน Session (กรุณากดเข้าสู่ระบบใหม่อีกครั้ง)");
    }

    // สเต็ป ก: แลก Authorization Code เป็น Access Token กับ LINE API โดยตรง
    const tokenParams = new URLSearchParams();
    tokenParams.set("grant_type", "authorization_code");
    tokenParams.set("code", code);
    tokenParams.set("redirect_uri", LINE_CONFIG.redirectUri);
    tokenParams.set("client_id", LINE_CONFIG.channelId);
    tokenParams.set("code_verifier", codeVerifier);

    const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "ไม่สามารถแลกสิทธิ์ Token จาก LINE ได้");
    }

    // สเต็ป ข: นำ Token ไปเปิดอ่านข้อมูลโปรไฟล์ (ID, ชื่อ, รูป)
    const profileRes = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!profileRes.ok) {
      throw new Error("ไม่สามารถดึงข้อมูลโปรไฟล์ LINE ได้");
    }

    const profileData = await profileRes.json();
    const lineUserId = profileData.userId;
    const lineDisplayName = profileData.displayName;
    const linePictureUrl = profileData.pictureUrl || "https://cdn-icons-png.flaticon.com/512/149/149071.png";

    // สเต็ป ค: เช็คสิทธิ์แบบ Real-time ผ่านคอลเลกชัน users บน Firestore
    const userAccess = await getUserByLineId(lineUserId);

    if (!userAccess) {
      showNoAccessScreen({
        id: lineUserId,
        name: lineDisplayName,
        picture: linePictureUrl
      });
      return;
    }

    const accessCheck = checkSystemPermission(userAccess, currentTargetSystem);
    if (!accessCheck.allowed) {
      showNoAccessScreen({
        id: lineUserId,
        name: lineDisplayName || userAccess.name,
        picture: linePictureUrl
      }, accessCheck.reason);
      return;
    }

    // สเต็ป ง: ผ่านสิทธิ์! สร้างก้อนข้อมูลผู้ใช้และบันทึก Audit Log
    const lineUserObj = {
      id: lineUserId,
      name: lineDisplayName || userAccess.name,
      picture: linePictureUrl,
      role: userAccess.role,
      allowedOptions: userAccess.allowedOptions || [],
      targetSystem: currentTargetSystem,
      isDevMode: false
    };

    const logDetail = currentTargetSystem === "hr"
      ? `พนักงานเข้าสู่ระบบ HR สำเร็จผ่าน LINE`
      : `พนักงานเข้าสู่ระบบหลังบ้านสำเร็จผ่าน LINE (Role: ${userAccess.role})`;

    await insertAuditLog("LOGIN", logDetail, lineUserObj);

    completeLoginAndRedirect(lineUserObj);

  } catch (err) {
    console.error("LINE Callback Error:", err);
    alert("เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์ LINE: " + err.message);
  } finally {
    setLoading(false);
  }
}

// ============================================================================
// 🔐 3. ตรวจสอบสิทธิ์แยกตามระบบ (อิงตามโครงสร้าง Firestore /users/{id} เดิม)
// ============================================================================
function checkSystemPermission(userAccess, targetSystem) {
  if (targetSystem === "hr") {
    // ระบบ HR: เช็กฟิลด์ hr === "active"
    if (userAccess.hr !== "active") {
      return {
        allowed: false,
        reason: `บัญชีของคุณยังไม่ได้รับอนุมัติสิทธิ์เข้าใช้งาน [ระบบบุคคล / HR] หรือสถานะไม่เป็น Active`
      };
    }
    return { allowed: true, reason: "" };
  }

  // ระบบหลังบ้าน (back-office): เช็กฟิลด์ status === "active"
  if (userAccess.status !== "active") {
    return {
      allowed: false,
      reason: `บัญชีของคุณยังไม่ได้รับอนุมัติสิทธิ์เข้าใช้งาน [ระบบหลังบ้าน] หรือสถานะไม่เป็น Active`
    };
  }

  return { allowed: true, reason: "" };
}

// ============================================================================
// 🎨 4. Helper Functions จัดการ UI และ Session
// ============================================================================
function completeLoginAndRedirect(userObj) {
  sessionStorage.setItem("atom_line_user", JSON.stringify(userObj));
  const targetUrl = SYSTEM_CONFIG[currentTargetSystem]?.redirectUrl || "back-office/index.html";
  window.location.href = targetUrl;
}

function showNoAccessScreen(userInfo, customReason = "") {
  document.getElementById("systemSelectSection").classList.add("d-none");
  document.getElementById("loginSection").classList.add("d-none");
  document.getElementById("noAccessSection").classList.remove("d-none");

  document.getElementById("noAccessPic").src = userInfo.picture;
  document.getElementById("noAccessName").textContent = userInfo.name;
  document.getElementById("noAccessIdText").value = userInfo.id;

  const reasonEl = document.getElementById("noAccessReasonText");
  if (reasonEl && customReason) {
    reasonEl.innerHTML = `บัญชี: <b>${userInfo.name}</b> — ${customReason}`;
  }
}

function setLoading(isLoading, text = "กำลังตรวจสอบสิทธิ์...") {
  const loadingBox = document.getElementById("loadingBox");
  const loadingText = document.getElementById("loadingText");
  const btnDev = document.getElementById("btnDevLogin");
  const btnLine = document.getElementById("btnLineLogin");

  loadingText.textContent = text;
  loadingBox.classList.toggle("d-none", !isLoading);
  btnDev.disabled = isLoading;
  btnLine.disabled = isLoading;
}

// ผูกฟังก์ชันเข้า window สำหรับปุ่ม onclick ใน HTML
window.selectTargetSystem = selectTargetSystem;
window.backToSystemSelect = backToSystemSelect;