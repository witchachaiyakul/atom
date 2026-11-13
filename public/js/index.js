// public/js/index.js
import { db, insertAuditLog } from "./firestore.js";

// ตัวแปร Global เก็บข้อมูลผู้ใช้งานปัจจุบัน (ใช้แทน template.lineUser ใน GAS เดิม)
window.currentUser = null;

document.addEventListener("DOMContentLoaded", () => {
  initUserSession();
  document.getElementById("btnLogout").addEventListener("click", handleLogout);
});

/**
 * 1. ตรวจสอบ Session จากหน้า Login และแสดงโปรไฟล์บน Navbar
 */
function initUserSession() {
  const rawUser = sessionStorage.getItem("atom_line_user");

  // ถ้ายังไม่ล็อกอิน ให้ดีดกลับไปหน้า login.html
  if (!rawUser) {
    window.location.href = "login.html";
    return;
  }

  try {
    const user = JSON.parse(rawUser);
    window.currentUser = user;

    // แสดงชื่อ, รูปโปรไฟล์ และ Role ที่มุมขวาบน
    document.getElementById("headerUserName").textContent = user.name || "ผู้ใช้งาน";
    document.getElementById("headerUserRole").textContent = user.role || "staff";
    if (user.picture) {
      document.getElementById("headerUserImg").src = user.picture;
    }

    // เปิดแสดงกล่องโปรไฟล์ส่วนหัว
    const profileBox = document.getElementById("userHeaderProfile");
    profileBox.classList.remove("d-none");
    profileBox.classList.add("d-flex");

    // กรองเมนูตามสิทธิ์ allowedOptions
    applyMenuPermissions(user);

  } catch (err) {
    console.error("Session ข้อมูลไม่ถูกต้อง:", err);
    sessionStorage.removeItem("atom_line_user");
    window.location.href = "login.html";
  }
}

/**
 * 2. กรองการ์ดเมนูบนหน้า Dashboard ตามสิทธิ์ allowedOptions จาก Firestore
 */
function applyMenuPermissions(user) {
  const role = (user.role || "").toLowerCase();
  const allowedList = (user.allowedOptions || []).map(opt => opt.toLowerCase());

  // ถ้าเป็น admin หรือมีสิทธิ์ "ALL" ให้แสดงทุกเมนูที่ไม่ได้ถูกปิดถาวรไว้
  if (role === "admin" || allowedList.includes("all")) {
    return;
  }

  // ถ้าเป็น staff ทั่วไป ให้เช็คทีละการ์ดตาม data-option
  const menuItems = document.querySelectorAll(".menu-item");
  menuItems.forEach((item) => {
    const optionKey = (item.getAttribute("data-option") || "").toLowerCase();
    if (!allowedList.includes(optionKey)) {
      item.classList.add("d-none");
    }
  });
}

/**
 * 3. ออกจากระบบ
 */
async function handleLogout() {
  if (!confirm("ต้องการออกจากระบบใช่หรือไม่?")) return;

  if (window.currentUser) {
    await insertAuditLog("LOGOUT", "ผู้ใช้งานกดออกจากระบบ", window.currentUser);
  }
  sessionStorage.removeItem("atom_line_user");
  window.location.href = "login.html";
}