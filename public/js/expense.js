// public/js/expense.js
import { db, storage, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  addDoc, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

window.currentUser = null;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("ExpenseEntry")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // โหลดตัวเลือก Master Data (สาขา, Supplier, ประเภทค่าใช้จ่าย) ใส่ Datalist
  await loadExpenseMasterData();
});

function verifyPageAccess(requiredOption) {
  const rawUser = sessionStorage.getItem("atom_line_user");
  if (!rawUser) {
    window.location.href = "login.html";
    return false;
  }

  try {
    const user = JSON.parse(rawUser);
    const role = (user.role || "").toLowerCase();
    const allowedList = (user.allowedOptions || []).map(opt => opt.toLowerCase());

    const hasAccess = role === "admin" || 
                      allowedList.includes("all") || 
                      allowedList.includes(requiredOption.toLowerCase());

    if (!hasAccess) {
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าบันทึกค่าใช้จ่าย");
      window.location.href = "index.html";
      return false;
    }

    window.currentUser = user;
    document.getElementById("headerUserName").textContent = user.name || "ผู้ใช้งาน";
    document.getElementById("headerUserRole").textContent = user.role || "staff";
    if (user.picture) document.getElementById("headerUserImg").src = user.picture;

    const profileBox = document.getElementById("userHeaderProfile");
    profileBox.classList.remove("d-none");
    profileBox.classList.add("d-flex");
    return true;
  } catch (err) {
    window.location.href = "login.html";
    return false;
  }
}

async function handleLogout() {
  if (!confirm("ต้องการออกจากระบบใช่หรือไม่?")) return;
  if (window.currentUser) {
    await insertAuditLog("LOGOUT", "ผู้ใช้งานกดออกจากระบบ", window.currentUser);
  }
  sessionStorage.removeItem("atom_line_user");
  window.location.href = "login.html";
}

// ============================================================================
// 📦 2. โหลดข้อมูล Master Data (รอรับโค้ดเดิมมาแปลง)
// ============================================================================
async function loadExpenseMasterData() {
  // TODO: ดึงข้อมูลใส่ #shopList, #supplierList, #itemList
}

// ============================================================================
// ➕ 3. บันทึก Master Data ใหม่จาก Modal (รอรับโค้ดเดิมมาแปลง)
// ============================================================================
async function saveNewSupplierMaster() {
  // TODO: บันทึก Supplier ลง Firestore และอัปเดต #supplierList
}

async function saveNewListMaster() {
  // TODO: บันทึกประเภทค่าใช้จ่ายลง Firestore และอัปเดต #itemList
}

// ============================================================================
// 🧮 4. คำนวณภาษี VAT 7% & จัดการ UI บนหน้าเว็บ (รอรับโค้ดเดิมมาแปลง)
// ============================================================================
function toggleVatDisplay(radioEl) {
  // TODO: เปิด/ปิดกล่องคำนวณ VAT
}

function calculateVat(inputEl) {
  // TODO: คำนวณฐานภาษี, VAT 7%, ยอดยกเว้นภาษี
}

function validateFileLimit(inputEl) {
  // TODO: ตรวจสอบจำนวนไฟล์ไม่เกิน 5 ไฟล์ และแสดงรายชื่อไฟล์
}

function addNewInvoiceBlock() {
  // TODO: Clone การ์ด Invoice ใบใหม่ พร้อมรีเซ็ตชื่อ radio group (vatGroup2, exemptGroup2...)
}

function removeInvoice(btnEl) {
  // TODO: ลบการ์ด Invoice และรันเลขลำดับใหม่
}

// ============================================================================
// 💾 5. บันทึกข้อมูล Invoice ทั้งหมด & รีเซ็ตฟอร์ม (รอรับโค้ดเดิมมาแปลง)
// ============================================================================
async function submitAllData() {
  // TODO: ตรวจสอบความถูกต้อง -> อัปโหลดไฟล์ -> บันทึกลง Firestore -> บันทึก Audit Log -> เปิด #successModal
}

function startNewEntry() {
  // TODO: ปิด Modal และล้างฟอร์มเพื่อเริ่มกรอกรอบใหม่
}

// ============================================================================
// 🔗 ผูกฟังก์ชันเข้า window เพื่อให้ HTML เรียกใช้ผ่าน onclick/onchange ได้
// ============================================================================
window.saveNewSupplierMaster = saveNewSupplierMaster;
window.saveNewListMaster = saveNewListMaster;
window.toggleVatDisplay = toggleVatDisplay;
window.calculateVat = calculateVat;
window.validateFileLimit = validateFileLimit;
window.addNewInvoiceBlock = addNewInvoiceBlock;
window.removeInvoice = removeInvoice;
window.submitAllData = submitAllData;
window.startNewEntry = startNewEntry;