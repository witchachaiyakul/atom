// public/hr/js/hr-log.js
import { db } from "../../js/firestore.js";
import { 
  doc, 
  setDoc 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ============================================================================
// 📝 1. บันทึก Audit Log ของระบบ HR ลง Collection "hr_logs"
// ============================================================================
export async function insertAuditLog(actionType, detailsTxt, lineUserObj) {
  try {
    // 1. ทำความสะอาดข้อความ (ลบขึ้นบรรทัดใหม่, ตัวอักษรล่องหน, และตัด space หน้า-หลัง)
    const sanitizeText = (val) => {
      if (val === null || val === undefined) return "";
      return String(val)
        .replace(/[\r\n\t]/g, " ")             // เปลี่ยนการขึ้นบรรทัดใหม่/Tab เป็นช่องว่าง
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // ลบตัวอักษรล่องหน (Zero-width characters)
        .replace(/["'\\]/g, "")                // ลบเครื่องหมายอัญประกาศคู่/เดี่ยว และ Backslash
        .trim();
    };

    let userId = "System";
    let userName = "Unknown";
    let userPicture = "";

    // 2. ตรวจสอบและดึงข้อมูล lineUserObj
    if (typeof lineUserObj === "string") {
      const cleanStr = lineUserObj.trim();

      if (cleanStr.startsWith("{") && cleanStr.endsWith("}")) {
        try {
          lineUserObj = JSON.parse(cleanStr);
        } catch (e) {
          // ถ้า Parse ไม่ผ่าน ให้ถือว่าเป็น String ID ตรงๆ
        }
      }

      if (typeof lineUserObj === "string") {
        userId = sanitizeText(lineUserObj);
        userName = userId;
      }
    }

    if (lineUserObj && typeof lineUserObj === "object") {
      userId = sanitizeText(lineUserObj.id || lineUserObj.userId || lineUserObj.user_id || "System");
      userName = sanitizeText(lineUserObj.name || lineUserObj.displayName || lineUserObj.user_name || "Unknown");
      userPicture = sanitizeText(lineUserObj.picture || lineUserObj.pictureUrl || lineUserObj.user_picture || "");
    }

    // 3. ประกอบข้อมูล Log
    const logData = {
      timestamp: new Date().toISOString(),
      action: sanitizeText(actionType) || "UNKNOWN_ACTION",
      details: sanitizeText(detailsTxt),
      user_id: userId || "System",
      user_name: userName || "Unknown",
      user_picture: userPicture
    };

    // 4. สร้าง Document ID และบันทึกลง Firestore Collection "hr_logs"
    const uuid = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID().substring(0, 8)
      : Math.random().toString(36).substring(2, 10);

    const logDocId = `LOG_${Date.now()}_${uuid}`;
    await setDoc(doc(db, "hr_logs", logDocId), logData);

    console.log(`✅ บันทึก HR Log สำเร็จ: [${logData.action}] - โดย: ${logData.user_name} (${logData.user_id})`);
  } catch (e) {
    console.error("❌ บันทึก Audit Log ลงถัง hr_logs ล้มเหลว:", e);
  }
}

// ============================================================================
// 🔐 2. ตรวจสอบ Session และแสดงชื่อผู้ใช้งานบน Navbar ทุกหน้าของ HR
// ============================================================================
export function initHRPageSession() {
  const rawUser = sessionStorage.getItem("atom_line_user");
  if (!rawUser) {
    window.location.href = "../login.html?system=hr";
    return null;
  }

  try {
    const user = JSON.parse(rawUser);
    window.currentUser = user;

    const nameEl = document.getElementById("headerUserName");
    const roleEl = document.getElementById("headerUserRole");
    const imgEl = document.getElementById("headerUserImg");
    const profileBox = document.getElementById("userHeaderProfile");
    const btnLogout = document.getElementById("btnLogout");

    if (nameEl) nameEl.textContent = user.name || "ผู้ใช้งาน";
    if (roleEl) roleEl.textContent = user.role || "staff";
    if (imgEl && user.picture) imgEl.src = user.picture;

    if (profileBox) {
      profileBox.classList.remove("d-none");
      profileBox.classList.add("d-flex");
    }

    if (btnLogout) {
      btnLogout.addEventListener("click", async () => {
        if (!confirm("ต้องการออกจากระบบ HR ใช่หรือไม่?")) return;
        await insertAuditLog("LOGOUT_HR", "ผู้ใช้งานกดออกจากระบบ HR", user);
        sessionStorage.removeItem("atom_line_user");
        window.location.href = "../login.html";
      });
    }

    return user;
  } catch (err) {
    sessionStorage.removeItem("atom_line_user");
    window.location.href = "../login.html?system=hr";
    return null;
  }
}

// ============================================================================
// ⏳ 3. Helper เปิด-ปิด Loading Overlay ของระบบ HR
// ============================================================================
export function showHRLoading(show = true) {
  const overlay = document.getElementById("loadingOverlay") || document.querySelector(".loading-overlay");
  if (overlay) {
    overlay.style.display = show ? "flex" : "none";
  }
}

// ผูกเข้า window เผื่อเรียกใช้งานจากสคริปต์ทั่วไป
window.insertAuditLog = insertAuditLog;
window.showHRLoading = showHRLoading;