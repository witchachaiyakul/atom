// public/hr/js/on-offboard.js
import { db } from "../../js/firestore.js";
import { insertAuditLog, initHRPageSession } from "./hr-log.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  collection,
  doc,
  getDocs,
  setDoc,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const storage = getStorage(getApp());

let globalPositionsData = {};
let currentCheckedName = "";
let isNameValid = true;

// =========================================================================
// 🚀 1. เริ่มต้นทำงานและโหลดข้อมูล Dropdown
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  await loadDropdownData();
});

async function loadDropdownData() {
  toggleLoader(true);
  try {
    const data = await getHRDropdowns();
    globalPositionsData = data.positions || {};

    const wpEl = document.getElementById("workplaceList");
    if (wpEl) {
      wpEl.innerHTML = data.workplaces.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    }

    const secEl = document.getElementById("sectionList");
    if (secEl) {
      secEl.innerHTML =
        `<option value="">-- เลือกแผนก --</option>` +
        data.sections.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    }

    const resignEl = document.getElementById("resignEmpList");
    if (resignEl) {
      resignEl.innerHTML =
        `<option value="">-- เลือกพนักงาน --</option>` +
        data.activeEmployees.map(emp => `<option value="${escapeHtml(emp.id)}">[${escapeHtml(emp.id)}] ${escapeHtml(emp.name)}</option>`).join("");
    }
  } finally {
    toggleLoader(false);
  }
}

async function getHRDropdowns() {
  const workplaces = ["Atom", "Atom Beach", "Good Time", "Paradise", "Tiger", "ครัวกลาง", "Office", "Pizza", "Musician"];
  const sections = ["Food & Beverage", "Kitchen", "Pizza", "Main Kitchen", "Office", "Bar"];
  const positions = {
    "Food & Beverage": ["Superviser", "Waitress", "Waiter", "Runner", "Captain", "Manager"],
    "Kitchen": ["Italian Chef", "Cook helper", "Helper", "Steward", "Sous Chef", "Japanese Chef", "Seafood Chef", "Euro eHelpr", "Commis1"],
    "Pizza": ["Pizza", "Pizza helper"],
    "Main Kitchen": ["Main Kitchen"],
    "Office": ["OPM", "Purchasing", "Techinician", "Accounting", "Office"],
    "Bar": ["Asst. Bar Manager", "Bartender", "Bartendy"]
  };

  try {
    const snap = await getDocs(collection(db, "hr"));
    const activeEmployees = [];

    snap.forEach(docSnap => {
      const emp = docSnap.data() || {};
      const docId = docSnap.id || emp.employee_id || "";

      if (emp.employment?.status !== "ออก" && emp.profile?.name) {
        activeEmployees.push({
          id: docId,
          name: emp.profile.name
        });
      }
    });

    activeEmployees.sort((a, b) => a.name.localeCompare(b.name, "th"));

    return { workplaces, sections, positions, activeEmployees };
  } catch (e) {
    console.error("Error getHRDropdowns:", e);
    return { workplaces, sections, positions, activeEmployees: [] };
  }
}

// =========================================================================
// 🔍 2. ตรวจสอบชื่อซ้ำ & ควบคุม Dropdown หน้าฟอร์ม
// =========================================================================
async function checkDuplicateName(name) {
  const cleanName = name ? name.trim() : "";
  const statusEl = document.getElementById("nameStatus");

  if (!cleanName) {
    if (statusEl) statusEl.innerText = "";
    isNameValid = true;
    return;
  }

  if (cleanName === currentCheckedName) return;

  try {
    const q = query(
      collection(db, "hr"),
      where("profile.name", "==", cleanName),
      limit(1)
    );
    const snap = await getDocs(q);
    const exists = !snap.empty;

    currentCheckedName = cleanName;
    isNameValid = !exists;

    if (statusEl) {
      statusEl.innerText = exists ? "⚠️ ชื่อนี้มีอยู่ในระบบแล้ว" : "";
    }
  } catch (e) {
    console.error("Error checkDuplicateName:", e);
  }
}

function updatePositionDropdown(selectedSection) {
  const positionSelect = document.getElementById("positionList");
  if (!positionSelect) return;

  if (!selectedSection) {
    positionSelect.innerHTML = `<option value="">-- กรุณาเลือกแผนกก่อน --</option>`;
    return;
  }

  const cleanSelect = selectedSection.trim().toLowerCase();
  const actualKey = Object.keys(globalPositionsData).find(key => key.trim().toLowerCase() === cleanSelect);

  if (!actualKey || !globalPositionsData[actualKey]) {
    positionSelect.innerHTML = `<option value="">-- ไม่พบตำแหน่งในแผนกนี้ --</option>`;
    return;
  }

  const availablePositions = globalPositionsData[actualKey];
  positionSelect.innerHTML = availablePositions.map(pos => `<option value="${escapeHtml(pos)}">${escapeHtml(pos)}</option>`).join("");
}

function toggleHousing(isCompany) {
  const detailInput = document.getElementById("housingDetail");
  if (detailInput) {
    detailInput.disabled = !isCompany;
    if (!isCompany) detailInput.value = "";
  }
}

// =========================================================================
// ➕ 3. บันทึกพนักงานใหม่ (สร้าง ID อัตโนมัติ + อัปโหลด Storage + บันทึก Firestore)
// =========================================================================
async function generateEmployeeIDs(shopName) {
  const branchMapping = {
    "atom": "1",
    "atom beach": "2",
    "good time": "3",
    "paradise": "4",
    "tiger": "5",
    "ครัวกลาง": "6",
    "office": "7",
    "pizza": "8",
    "musician": "9"
  };

  const cleanShop = String(shopName || "").toLowerCase().trim();
  const prefix = branchMapping[cleanShop] || "1";

  try {
    const snap = await getDocs(collection(db, "hr"));
    let maxNum = 0;

    snap.forEach(docSnap => {
      const data = docSnap.data() || {};
      const idStr = String(data.employee_id || docSnap.id || "").trim();
      if (idStr.startsWith(prefix) && idStr.length === 4) {
        const numPart = parseInt(idStr.substring(1), 10);
        if (!isNaN(numPart) && numPart > maxNum) {
          maxNum = numPart;
        }
      }
    });

    const nextNum = maxNum + 1;
    return prefix + nextNum.toString().padStart(3, "0");
  } catch (e) {
    console.error("Error generateEmployeeIDs:", e);
    const randomNum = Math.floor(Math.random() * 900 + 100);
    return prefix + randomNum.toString();
  }
}

async function submitNewEmployee() {
  const form = document.getElementById("newEmpForm");
  const nameVal = (form.name?.value || "").trim();

  if (!nameVal) {
    alert("กรุณากรอกชื่อ-นามสกุลพนักงาน");
    form.name?.focus();
    return;
  }

  await checkDuplicateName(nameVal);
  const statusElement = document.getElementById("nameStatus");
  if (!isNameValid || (statusElement && statusElement.innerText !== "")) {
    alert("กรุณาแก้ไขชื่อพนักงานที่ซ้ำในระบบให้เรียบร้อยก่อนครับ");
    return;
  }

  const submitBtn = document.getElementById("btnSubmitNewEmp");
  const originalBtnHtml = submitBtn ? submitBtn.innerHTML : "";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังอัปโหลดไฟล์และบันทึกข้อมูล...`;
  }

  const safeUser = window.currentUser || "System";
  let newId = "Pending";
  toggleLoader(true);

  try {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    data.socialSec = form.socialSec ? form.socialSec.checked : false;

    // 1. ออกเลข ID พนักงานใหม่ตามสาขา
    newId = await generateEmployeeIDs(data.workplace);

    // 2. อัปโหลดไฟล์รูปภาพตรงขึ้น Firebase Storage (ไม่ต้องแปลง Base64)
    const attachUrls = {
      profile_image_drive: "",
      passport_image_drive: "",
      visa_image_drive: "",
      work_permit_image_drive: "",
      owic_image_drive: "",
      pink_id_image_drive: "",
      health_card_image_drive: "",
      other_5_image_drive: "",
      other_6_image_drive: "",
      other_7_image_drive: "",
      other_8_image_drive: "",
      other_9_image_drive: "",
      other_10_image_drive: "",
      owic_image_drive: "",
      pink_id_image_drive: "",
      health_card_image_drive: ""
    };

    const fileMapTasks = [
      { inputName: "fileEmp", target: "profile_image_drive", suffix: "" },
      { inputName: "filePassport", target: "passport_image_drive", suffix: "-passport" },
      { inputName: "fileVisa", target: "visa_image_drive", suffix: "-visa" },
      { inputName: "fileWP", target: "work_permit_image_drive", suffix: "-workpermit" },
      { inputName: "fileOther5", target: "other_5_image_drive", suffix: "-other5" },
      { inputName: "fileOther6", target: "other_6_image_drive", suffix: "-other6" },
      { inputName: "fileOther7", target: "other_7_image_drive", suffix: "-other7" },
      { inputName: "fileOther8", target: "other_8_image_drive", suffix: "-other8" },
      { inputName: "fileOther9", target: "other_9_image_drive", suffix: "-other9" },
      { inputName: "fileOther10", target: "other_10_image_drive", suffix: "-other10" }
    ];

    for (const task of fileMapTasks) {
      const fileInput = form[task.inputName];
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (file) {
        try {
          const ext = file.name.split(".").pop().toLowerCase() || "png";
          const storagePath = `hr_attachments/${newId}/${newId}${task.suffix}.${ext}`;
          const fileRef = ref(storage, storagePath);

          await uploadBytes(fileRef, file);
          attachUrls[task.target] = await getDownloadURL(fileRef);
        } catch (uploadErr) {
          console.error(`ล้มเหลวขณะอัปโหลดรูปสล็อต ${task.target}:`, uploadErr);
        }
      }
    }

    // 3. คำนวณเงินสมทบประกันสังคม
    const newSalary = Number(data.salary) || 0;
    const isSocialSecNew = Boolean(data.socialSec);
    let eeContribNew = 0;
    let erContribNew = 0;

    if (isSocialSecNew && newSalary > 0) {
      const baseSalaryNew = Math.min(Math.max(newSalary, 1650), 17500);
      eeContribNew = Math.round(baseSalaryNew * 0.05);
      erContribNew = Math.round(baseSalaryNew * 0.05);
    }

    // จัดรูปแบบรหัสบันทึกเวลา (PID)
    const cleanPid = String(data.pid || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .join(",");

    // 4. ประกอบโครงสร้างเอกสารและบันทึกลง Firestore
    const employeeDoc = {
      employee_id: String(newId),
      pid: cleanPid,
      no: 999,
      profile: {
        name: nameVal,
        nickname: (data.nickname || "").trim(),
        gender: data.gender || "",
        nationality: data.nationality || "",
        date_of_birth: "",
        age: 0,
        address: "",
        tel: ""
      },
      employment: {
        shop: data.workplace || "",
        employer: "",
        section: data.section || "",
        position: data.position || "",
        salary: newSalary,
        status: "ปกติ",
        type: "ทดลองงาน",
        start_date: data.startDate || "",
        end_date: "",
        tenure: "",
        contract_start: "",
        contract_end: ""
      },
      documents: {
        passport: { id: (data.passportId || "").trim(), expiry_date: "" },
        work_permit: { id: "", expiry_date: "" },
        visa: { admitted_date: "", until_date: "" },
        report_90_days: { due_date: "" }
      },
      welfare: {
        social_security: isSocialSecNew,
        ss_salary: isSocialSecNew ? newSalary : 0,
        Employee_Contribution: eeContribNew,
        Employer_Contribution: erContribNew,
        housing: {
          type: data.housing === "Outside" ? "Outside" : "Company",
          detail: (data.housingDetail || "").trim(),
          accommodation_cost: 0,
          subsidy: 0
        }
      },
      attachments: attachUrls,
      system: {
        check_list: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    };

    await setDoc(doc(db, "hr", String(newId)), employeeDoc);

    await insertAuditLog(
      "ADD_HR_SUCCESS",
      `เพิ่มพนักงานใหม่สำเร็จ รหัส ${newId} (ชื่อ: ${nameVal})`,
      safeUser
    );

    alert(`✅ บันทึกพนักงานใหม่สำเร็จ (รหัสพนักงาน: ${newId})`);
    form.reset();
    toggleHousing(false);
    currentCheckedName = "";
    if (statusElement) statusElement.innerText = "";

    await loadDropdownData();
  } catch (err) {
    console.error("Error submitNewEmployee:", err);
    await insertAuditLog(
      "ADD_HR_FAILED",
      `❌ เพิ่มพนักงานใหม่ล้มเหลว (รหัสที่คาดการณ์: ${newId}, ชื่อ: ${nameVal}) | สาเหตุ: ${err.message}`,
      safeUser
    );
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    toggleLoader(false);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHtml;
    }
  }
}

// =========================================================================
// 🚪 4. บันทึกการลาออก (อัปโหลดใบลาออก + อัปเดตสถานะ เหตุผล และวันที่ลาออก)
// =========================================================================
async function submitResignation() {
  const resignSelect = document.querySelector('[name="resignName"]');
  const empId = resignSelect ? resignSelect.value : "";
  const empText = resignSelect && resignSelect.selectedIndex >= 0
    ? resignSelect.options[resignSelect.selectedIndex].text
    : empId;
  const date = document.querySelector('[name="resignDate"]')?.value || "";
  const reason = (document.getElementById("resignReason")?.value || "").trim();
  const fileInput = document.getElementById("fileResign");
  const resignFile = fileInput && fileInput.files ? fileInput.files[0] : null;
  const btn = document.getElementById("btnSubmitResign");

  if (!empId || !date) {
    alert("กรุณาเลือกพนักงานและวันที่ลาออกให้ครบถ้วน");
    return;
  }

  if (!reason) {
    alert("กรุณาระบุเหตุผลการลาออก");
    document.getElementById("resignReason")?.focus();
    return;
  }

  if (!confirm(`ยืนยันการบันทึกสถานะ "ลาออก" ของ ${empText} มีผลวันที่ ${date} ใช่หรือไม่?`)) {
    return;
  }

  const originalBtnText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังอัปโหลดและบันทึก...`;
  }

  const safeUser = window.currentUser || "System";
  const cleanEmpId = String(empId).trim().padStart(4, "0");
  toggleLoader(true);

  try {
    // 1. อัปโหลดเอกสารใบลาออกขึ้น Firebase Storage (ถ้ามีการแนบไฟล์)
    let resignDocUrl = "";
    if (resignFile) {
      const ext = resignFile.name.split(".").pop().toLowerCase() || "pdf";
      const storagePath = `hr_attachments/${cleanEmpId}/${cleanEmpId}-resign.${ext}`;
      const fileRef = ref(storage, storagePath);

      await uploadBytes(fileRef, resignFile);
      resignDocUrl = await getDownloadURL(fileRef);
    }

    // 2. เตรียมข้อมูลอัปเดตลง Firestore
    const updatePayload = {
      employment: {
        status: "ออก",
        end_date: date,
        resign_reason: reason
      },
      system: {
        updated_at: new Date().toISOString()
      }
    };

    // ถ้ามีไฟล์ใบลาออก ให้เก็บลิงก์ลงในก้อน attachments ด้วย
    if (resignDocUrl) {
      updatePayload.attachments = {
        resignation_doc_drive: resignDocUrl
      };
    }

    await setDoc(doc(db, "hr", cleanEmpId), updatePayload, { merge: true });

    // 3. บันทึก Audit Log ลง hr_logs
    const logDetail = `บันทึกแจ้งลาออกของ ${empText} (ID: ${cleanEmpId}) วันที่: ${date} | เหตุผล: ${reason}` +
      (resignDocUrl ? " | แนบใบลาออกแล้ว" : "");

    await insertAuditLog("RESIGN_HR_SUCCESS", logDetail, safeUser);

    alert("✅ บันทึกการลาออกสำเร็จ");
    document.getElementById("resignForm").reset();
    await loadDropdownData();
  } catch (err) {
    console.error("Error submitResignation:", err);
    await insertAuditLog(
      "RESIGN_HR_FAILED",
      `❌ บันทึกการลาออกล้มเหลว (ID: ${cleanEmpId}, วันที่: ${date}) | สาเหตุ: ${err.message}`,
      safeUser
    );
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    toggleLoader(false);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnText;
    }
  }
}

// =========================================================================
// 🛠️ Helper Functions
// =========================================================================
function toggleLoader(show) {
  const loader = document.getElementById("loader");
  if (loader) loader.style.display = show ? "flex" : "none";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window สำหรับเรียกใช้จาก HTML
window.checkDuplicateName = checkDuplicateName;
window.updatePositionDropdown = updatePositionDropdown;
window.toggleHousing = toggleHousing;
window.submitNewEmployee = submitNewEmployee;
window.submitResignation = submitResignation;