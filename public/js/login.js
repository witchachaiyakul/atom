// public/js/auth.js
import { getUserByLineId, insertAuditLog } from "./firestore.js";

// ============================================================================
// 🎯 [ตั้งค่าระบบ & สวิตช์โหมดทดสอบ]
// ============================================================================
const IS_DEV_MODE = true; // true = เปิดช่องกรอก LINE User ID ทดสอบ | false = บังคับ LINE Login จริง

const DEV_DEFAULT_LINE_ID = "Ub1c1cb6c91bee88632afa055e2a98fcd"; // ID พนักงานตัวอย่างสำหรับ Dev Mode (สามารถเปลี่ยนได้ตามต้องการ)

const LINE_CONFIG = {
  channelId: "2010270196",
  redirectUri: window.location.origin + window.location.pathname,
  // Endpoint Backend / Cloud Function สำหรับแลก code -> profile (ซ่อน Channel Secret)
  tokenExchangeApi: "https://YOUR_REGION-studio-1060072528-ff5ab.cloudfunctions.net/lineAuthCallback"
};

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

  // ตรวจสอบว่ามีการ Redirect กลับมาจาก LINE (?code=...) หรือไม่
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");

  if (code) {
    await handleLineCallback(code, state);
  }
});

// ============================================================================
// 🛠️ 1. ฟังก์ชันเข้าสู่ระบบผ่าน DEV MODE (เช็ค Collection /users/{id} จริง)
// ============================================================================
async function handleDevLogin() {
  const inputId = document.getElementById("devLineIdInput").value.trim();
  if (!inputId) {
    alert("กรุณากรอก LINE User ID ก่อนครับ");
    return;
  }

  setLoading(true, `กำลังตรวจสอบสิทธิ์ ID: ${inputId}...`);

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

    const lineUserObj = {
      id: inputId,
      name: userAccess.name || "Dev_User",
      picture: "https://cdn-icons-png.flaticon.com/512/149/149071.png",
      role: userAccess.role,
      allowedOptions: userAccess.allowedOptions,
      isDevMode: true
    };

    await insertAuditLog(
      "LOGIN_DEV",
      `เข้าสู่ระบบผ่าน Dev Mode สำเร็จ (User: ${lineUserObj.name}, Role: ${userAccess.role})`,
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
  setLoading(true, "กำลังยืนยันตัวตนกับ LINE...");
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

    const lineUserObj = {
      id: lineUserId,
      name: lineDisplayName || userAccess.name,
      picture: linePictureUrl,
      role: userAccess.role,
      allowedOptions: userAccess.allowedOptions,
      isDevMode: false
    };

    await insertAuditLog(
      "LOGIN",
      `พนักงานเข้าสู่ระบบสำเร็จผ่าน LINE (Role: ${userAccess.role})`,
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
// 🎨 3. Helper Functions จัดการ UI และ Session
// ============================================================================
function completeLoginAndRedirect(userObj) {
  sessionStorage.setItem("atom_line_user", JSON.stringify(userObj));
  window.location.href = "index.html";
}

function showNoAccessScreen(userInfo) {
  document.getElementById("loginSection").classList.add("d-none");
  document.getElementById("noAccessSection").classList.remove("d-none");

  document.getElementById("noAccessPic").src = userInfo.picture;
  document.getElementById("noAccessName").textContent = userInfo.name;
  document.getElementById("noAccessIdText").value = userInfo.id;
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