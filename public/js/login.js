// public/js/login.js
import { getUserByLineId, insertAuditLog } from "./firestore.js";

// ============================================================================
// 🎯 [ตั้งค่าระบบ & สวิตช์โหมดทดสอบ]
// ============================================================================
const IS_DEV_MODE = true; // true = เปิดช่องกรอก LINE User ID ทดสอบ | false = บังคับ LINE Login จริง

const DEV_DEFAULT_LINE_ID = "Ub1c1cb6c91bee88632afa055e2a98fcd";

const LINE_CONFIG = {
  channelId: "2010270196",
  redirectUri: window.location.origin + window.location.pathname,
  // Endpoint Backend / Cloud Function สำหรับแลก code -> profile (ซ่อน Channel Secret)
  tokenExchangeApi: "https://YOUR_REGION-studio-1060072528-ff5ab.cloudfunctions.net/lineAuthCallback"
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
        name: "Dev Test User (ไม่พบข้อมูลหรือ Inactive)",
        picture: "https://cdn-icons-png.flaticon.com/512/149/149071.png"
      });
      return;
    }

    // ตรวจสอบสิทธิ์ตามระบบที่เลือก
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

    await insertAuditLog(
      "LOGIN_DEV",
      `เข้าสู่${sysCfg.label}ผ่าน Dev Mode สำเร็จ (User: ${lineUserObj.name}, Role: ${userAccess.role})`,
      lineUserObj
    );

    completeLoginAndRedirect(lineUserObj);

  } catch (error) {
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อ Firestore: " + error.message);
  } finally {
    setLoading(false);
  }
}

// ============================================================================
// 🟢 2. ฟังก์ชัน LINE Login OAuth2 (Production Mode)
// ============================================================================
function redirectToLineLogin() {
  // บันทึกระบบที่เลือกไว้ก่อนเด้งไป LINE
  sessionStorage.setItem("atom_selected_system", currentTargetSystem);

  const state = crypto.randomUUID();
  sessionStorage.setItem("line_oauth_state", state);

  const authUrl = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", LINE_CONFIG.channelId);
  authUrl.searchParams.set("redirect_uri", LINE_CONFIG.redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "profile openid");

  window.location.href = authUrl.toString();
}

async function handleLineCallback(code, returnedState) {
  const sysCfg = SYSTEM_CONFIG[currentTargetSystem];
  setLoading(true, `กำลังยืนยันตัวตนเข้าสู่${sysCfg.label}...`);
  window.history.replaceState({}, document.title, window.location.pathname);

  try {
    const savedState = sessionStorage.getItem("line_oauth_state");
    if (savedState && returnedState !== savedState) {
      throw new Error("State ไม่ตรงกัน (อาจเกิดจาก CSRF หรือ Session หมดอายุ)");
    }

    const response = await fetch(LINE_CONFIG.tokenExchangeApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
        redirect_uri: LINE_CONFIG.redirectUri
      })
    });

    if (!response.ok) throw new Error("ไม่สามารถแลก Token จาก LINE ได้");
    const profileData = await response.json();

    const lineUserId = profileData.userId;
    const lineDisplayName = profileData.displayName;
    const linePictureUrl = profileData.pictureUrl || "https://cdn-icons-png.flaticon.com/512/149/149071.png";

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

    const lineUserObj = {
      id: lineUserId,
      name: lineDisplayName || userAccess.name,
      picture: linePictureUrl,
      role: userAccess.role,
      allowedOptions: userAccess.allowedOptions || [],
      targetSystem: currentTargetSystem,
      isDevMode: false
    };

    await insertAuditLog(
      "LOGIN",
      `พนักงานเข้าสู่${sysCfg.label}สำเร็จผ่าน LINE (Role: ${userAccess.role})`,
      lineUserObj
    );

    completeLoginAndRedirect(lineUserObj);

  } catch (err) {
    console.error("LINE Callback Error:", err);
    alert("เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์ LINE: " + err.message);
  } finally {
    setLoading(false);
  }
}

// ============================================================================
// 🔐 3. ตรวจสอบสิทธิ์แยกตามระบบ (Back-Office vs HR)
// ============================================================================
function checkSystemPermission(userAccess, targetSystem) {
  const role = (userAccess.role || "").toLowerCase();
  const allowedOptions = Array.isArray(userAccess.allowedOptions) ? userAccess.allowedOptions : [];

  if (targetSystem === "back-office") {
    // ระบบหลังบ้าน: ต้องเป็น admin หรือมีสิทธิ์เมนูใน allowedOptions อย่างน้อย 1 รายการ
    const hasBackofficeAccess = role === "admin" || allowedOptions.length > 0;
    if (!hasBackofficeAccess) {
      return {
        allowed: false,
        reason: `บัญชีของคุณไม่มีสิทธิ์เข้าใช้งาน [ระบบหลังบ้าน] (สามารถเข้าใช้งานเฉพาะระบบ HR ได้)`
      };
    }
  }

  // ระบบ HR: พนักงานที่มีสถานะ active ใน /users/{id} สามารถเข้าใช้งานได้ทุกคน
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