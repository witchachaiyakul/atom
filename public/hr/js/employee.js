// public/hr/js/employee.js
import { db } from "../../js/firestore.js";
import { insertAuditLog, initHRPageSession } from "./hr-log.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const storage = getStorage(getApp());

let rawData = [];
let employerOptions = ["Atom Group", "Atom Beach", "Good Time", "Tiger King Bar & Bistro", "Paradise"];

const NO_PHOTO_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='100' viewBox='0 0 24 24' fill='%23ccc'><rect width='100%' height='100%' fill='%23f1f1f1'/><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5-4-8-4z'/></svg>";

// =========================================================================
// 🚀 1. เริ่มต้นโหลดหน้าเว็บและดึงข้อมูลพนักงาน
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  toggleLoader(true);
  try {
    rawData = await getEmployeeData();
    populateFilterDropdowns(rawData);
    filterData();
  } catch (err) {
    console.error("Init Employee Page Error:", err);
  } finally {
    toggleLoader(false);
  }
});

function populateFilterDropdowns(data) {
  const workSelect = document.getElementById("searchWork");
  const shops = new Set();
  const employers = new Set(employerOptions);

  data.forEach(item => {
    if (item.work && item.work !== "-") shops.add(item.work.trim());
    if (item.employer && item.employer !== "-") employers.add(item.employer.trim());
  });

  if (workSelect) {
    const currentVal = workSelect.value;
    workSelect.innerHTML = `<option value="">-- ทุกสาขา/ร้าน --</option>`;
    Array.from(shops).sort().forEach(shop => {
      workSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(shop)}">${escapeHtml(shop)}</option>`);
    });
    workSelect.value = currentVal;
  }

  employerOptions = Array.from(employers);
}

// =========================================================================
// 📡 2. ฟังก์ชันดึงข้อมูลและรูปภาพพนักงานจาก Firestore
// =========================================================================
async function getEmployeeData() {
  try {
    const snap = await getDocs(collection(db, "hr"));
    if (snap.empty) return [];

    const employees = [];
    snap.forEach(docSnap => {
      const flatDoc = docSnap.data() || {};
      const empId = flatDoc.employee_id || docSnap.id;

      employees.push({
        id: empId,
        pid: String(flatDoc.pid ?? flatDoc.profile?.pid ?? "-"),
        emp_id_display: empId,
        name: flatDoc.profile?.name || "-",
        nick: flatDoc.profile?.nickname || "-",
        work: flatDoc.employment?.shop || "-",
        employer: flatDoc.employment?.employer || "-",
        section: flatDoc.employment?.section || "-",
        position: flatDoc.employment?.position || "-",
        status: flatDoc.employment?.status || "ปกติ",
        salary: Number(flatDoc.employment?.salary) || 0,
        profile_image: flatDoc.attachments?.profile_image_drive || "",
        attachments: flatDoc.attachments || {},
        welfare: flatDoc.welfare || {}
      });
    });

    return employees.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  } catch (e) {
    console.error("Error getEmployeeData:", e);
    return [];
  }
}

async function getEmployeePhotos(name, id) {
  try {
    if (!id) throw new Error("ไม่พบรหัสพนักงาน (ID เป็นค่าว่าง)");
    const cleanId = String(id).trim().padStart(4, "0");

    const docSnap = await getDoc(doc(db, "hr", cleanId));
    if (!docSnap.exists()) throw new Error("ไม่พบเอกสารพนักงานรหัส: " + cleanId);

    const flatDoc = docSnap.data() || {};
    const attach = flatDoc.attachments || {};

    return {
      profile: attach.profile_image_drive || NO_PHOTO_SVG,
      passport: attach.passport_image_drive || NO_PHOTO_SVG,
      visa: attach.visa_image_drive || NO_PHOTO_SVG,
      workpermit: attach.work_permit_image_drive || NO_PHOTO_SVG,
      other5: attach.other_5_image_drive || NO_PHOTO_SVG,
      other6: attach.other_6_image_drive || NO_PHOTO_SVG,
      other7: attach.other_7_image_drive || NO_PHOTO_SVG,
      other8: attach.other_8_image_drive || NO_PHOTO_SVG,
      other9: attach.other_9_image_drive || NO_PHOTO_SVG,
      other10: attach.other_10_image_drive || NO_PHOTO_SVG
    };
  } catch (e) {
    console.error("Error getEmployeePhotos:", e.message);
    return {
      profile: NO_PHOTO_SVG,
      passport: NO_PHOTO_SVG,
      visa: NO_PHOTO_SVG,
      workpermit: NO_PHOTO_SVG,
      other5: NO_PHOTO_SVG,
      other6: NO_PHOTO_SVG,
      other7: NO_PHOTO_SVG,
      other8: NO_PHOTO_SVG,
      other9: NO_PHOTO_SVG,
      other10: NO_PHOTO_SVG
    };
  }
}

// =========================================================================
// 🔍 3. คัดกรองและแสดงการ์ดรายการพนักงาน
// =========================================================================
function filterData() {
  const queryText = (document.getElementById("searchName")?.value || "").toLowerCase().trim();
  const workQuery = document.getElementById("searchWork")?.value || "";
  const statusQuery = document.getElementById("searchStatus")?.value || "";

  const filtered = rawData.filter(item => {
    const matchesName =
      (item.name || "").toLowerCase().includes(queryText) ||
      (item.nick || "").toLowerCase().includes(queryText) ||
      String(item.id || "").toLowerCase().includes(queryText) ||
      String(item.pid || "").toLowerCase().includes(queryText);
    const matchesWork = workQuery === "" || item.work === workQuery;
    const matchesStatus = statusQuery === "" || item.status === statusQuery;
    return matchesName && matchesWork && matchesStatus;
  });

  renderEmployees(filtered);
}

function renderEmployees(data) {
  const list = document.getElementById("employeeList");
  if (!list) return;
  list.innerHTML = "";

  if (data.length === 0) {
    list.innerHTML = `<div class="text-center py-5 text-muted bg-white rounded shadow-sm">ไม่พบข้อมูลพนักงานตามเงื่อนไขที่ค้นหา</div>`;
    return;
  }

  data.forEach(emp => {
    const statusBadge = emp.status === "ปกติ" ? "bg-success" : "bg-danger";
    const safeId = escapeHtml(String(emp.id)).replace(/'/g, "\\'");
    const profileImg = emp.profile_image || (emp.attachments && emp.attachments.profile_image_drive) || NO_PHOTO_SVG;

    const cardHtml = `
      <div class="emp-item-card mb-3 p-3 shadow-sm bg-white rounded">
        <div class="row align-items-center">
          <div class="col-auto">
            <div class="bg-light border rounded overflow-hidden" style="width: 75px; height: 95px;">
              <img src="${profileImg}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.src='${NO_PHOTO_SVG}'">
            </div>
          </div>
          <div class="col">
            <div class="small text-muted fw-bold">รหัส: ${escapeHtml(emp.id)}</div>
            <div class="small text-muted fw-bold">รหัส: ${escapeHtml(emp.id)} | PID: ${escapeHtml(emp.pid || "-")} </div>
            <h5 class="fw-bold mb-1">${escapeHtml(emp.name)} ${emp.nick && emp.nick !== "-" ? `<span class="text-muted fw-normal fs-6">(${escapeHtml(emp.nick)})</span>` : ""}</h5>
            <p class="small mb-1 text-muted">ร้าน: <strong>${escapeHtml(emp.work || "-")}</strong> | ตำแหน่ง: ${escapeHtml(emp.position || "-")}</p>
            <span class="badge ${statusBadge}">${escapeHtml(emp.status || "ปกติ")}</span>
          </div>
          <div class="col-auto">
            <button class="btn btn-sm btn-warning fw-bold px-3" onclick="viewDetail('${safeId}')">
              <i class="bi bi-eye me-1"></i>รายละเอียด
            </button>
          </div>
        </div>
      </div>
    `;
    list.insertAdjacentHTML("beforeend", cardHtml);
  });
}

// =========================================================================
// 📋 4. เปิด Modal ดูรายละเอียดและแก้ไขข้อมูลพนักงาน
// =========================================================================
async function viewDetail(empIdOrName) {
  const emp = rawData.find(item => String(item.id) === String(empIdOrName) || item.name === empIdOrName);
  if (!emp) return;

  toggleLoader(true);
  try {
    const empId = emp.id || emp.emp_id_display || "";
    const photos = await getEmployeePhotos(emp.name, empId);

    const empSalary = Number(emp.salary || 0);
    const empSSSalary = emp.welfare && emp.welfare.ss_salary !== undefined ? Number(emp.welfare.ss_salary) : empSalary;

    const hType = emp.welfare?.housing?.type || "Outside";
    const hDetail = emp.welfare?.housing?.detail || "-";
    const accCost = Number(emp.welfare?.housing?.accommodation_cost || 0);
    const hSubsidy = Number(emp.welfare?.housing?.subsidy || 0);

    let hCostText = "-";
    if (hType.toLowerCase() === "company") {
      hCostText = "หักเงิน " + accCost.toLocaleString() + " บาท";
    } else if (hType.toLowerCase() === "outside") {
      hCostText = "ช่วยเหลือ " + hSubsidy.toLocaleString() + " บาท";
    }

    const empOpts = employerOptions.map(opt => {
      const isSelected = opt === emp.employer ? "selected" : "";
      return `<option value="${escapeHtml(opt)}" ${isSelected}>${escapeHtml(opt)}</option>`;
    }).join("");

    const safeIdForSave = escapeHtml(String(empId)).replace(/'/g, "\\'");

    const hasSS = emp.welfare && (emp.welfare.social_security === true || emp.welfare.social_security === "true");
    const eeContrib = emp.welfare?.Employee_Contribution || 0;
    const erContrib = emp.welfare?.Employer_Contribution || 0;

    const ssViewText = hasSS
      ? `มี (หักพนักงาน ${Number(eeContrib).toLocaleString()} บาท / สมทบนายจ้าง ${Number(erContrib).toLocaleString()} บาท)`
      : "ไม่มี";
    const ssChecked = hasSS ? "checked" : "";

    const contentHtml = `
      <div class="card border-0 p-3 mb-4 shadow-sm">
        <div class="row">
          <div class="col-md-3 text-center border-end">
            <img src="${photos.profile}" class="img-fluid rounded border mb-2 shadow-sm" style="max-height: 200px; cursor: pointer;" onclick="showFullImage('${photos.profile}')">
            <h6 class="fw-bold mb-0" style="color: var(--secondary-orange);">${escapeHtml(emp.name)}</h6>
            <p class="small text-muted">ID: ${escapeHtml(empId || "-")}</p>
          </div>
          <div class="col-md-5 px-4 border-end">
            <table class="table table-sm table-borderless small">
              <tr><td class="fw-bold" width="40%">ชื่อ</td><td><span class="view-mode">${escapeHtml(emp.name)}</span><input type="text" id="edit_name" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.name)}"></td></tr>
              <tr><td class="fw-bold">PID</td><td><span class="view-mode">${escapeHtml(emp.pid || "-")}</span><input type="text" id="edit_pid" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.pid === "-" ? "" : emp.pid)}"></td></tr>
              <tr><td class="fw-bold">ชื่อเล่น</td><td><span class="view-mode">${escapeHtml(emp.nick || "-")}</span><input type="text" id="edit_nick" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.nick === "-" ? "" : emp.nick)}"></td></tr>
              <tr><td class="fw-bold">สาขา/ร้าน</td><td><span class="view-mode">${escapeHtml(emp.work || "-")}</span><input type="text" id="edit_work" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.work === "-" ? "" : emp.work)}"></td></tr>
              <tr><td class="fw-bold">นายจ้าง</td><td><span class="view-mode">${escapeHtml(emp.employer || "-")}</span><select id="edit_employer" class="form-select form-select-sm edit-mode d-none">${empOpts}</select></td></tr>
              <tr><td class="fw-bold">แผนก</td><td><span class="view-mode">${escapeHtml(emp.section || "-")}</span><input type="text" id="edit_section" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.section === "-" ? "" : emp.section)}"></td></tr>
              <tr><td class="fw-bold">ตำแหน่ง</td><td><span class="view-mode">${escapeHtml(emp.position || "-")}</span><input type="text" id="edit_position" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(emp.position === "-" ? "" : emp.position)}"></td></tr>
              <tr><td class="fw-bold">ฐานเงินเดือนจริง</td><td><span class="view-mode">${empSalary.toLocaleString()} บาท</span><input type="number" id="edit_salary" class="form-control form-control-sm edit-mode d-none" value="${empSalary}"></td></tr>
              <tr><td class="fw-bold text-primary">เงินเดือนคิดประกันสังคม</td><td><span class="view-mode">${empSSSalary.toLocaleString()} บาท</span><input type="number" id="edit_ssSalary" class="form-control form-control-sm edit-mode d-none" value="${empSSSalary}"></td></tr>
              <tr><td class="fw-bold">ประเภทที่พัก</td><td><span class="view-mode">${escapeHtml(hType)}</span><select id="edit_housingType" class="form-select form-select-sm edit-mode d-none"><option value="Company" ${hType === "Company" ? "selected" : ""}>บ้านพักบริษัท (Company)</option><option value="Outside" ${hType.toLowerCase() === "outside" ? "selected" : ""}>ข้างนอก (Outside)</option></select></td></tr>
              <tr><td class="fw-bold">รายละเอียดที่พัก</td><td><span class="view-mode">${escapeHtml(hDetail)}</span><input type="text" id="edit_housingDetail" class="form-control form-control-sm edit-mode d-none" value="${escapeHtml(hDetail === "-" ? "" : hDetail)}"></td></tr>
              <tr><td class="fw-bold">ค่าที่พัก (หัก/ช่วย)</td><td><span class="view-mode">${hCostText}</span><div class="edit-mode d-none"><div class="row g-1"><div class="col-6"><small class="text-muted d-block">ยอดหัก (Company)</small><input type="number" id="edit_accommodationCost" class="form-control form-control-sm" value="${accCost}"></div><div class="col-6"><small class="text-muted d-block">ยอดช่วย (Outside)</small><input type="number" id="edit_subsidy" class="form-control form-control-sm" value="${hSubsidy}"></div></div></div></td></tr>
              <tr><td class="fw-bold">ประกันสังคม</td><td><span class="view-mode">${ssViewText}</span><div class="form-check edit-mode d-none"><input class="form-check-input" type="checkbox" id="edit_socialSec" ${ssChecked}><label class="form-check-label" for="edit_socialSec">ใช้สิทธิ์ประกันสังคม</label></div></td></tr>
            </table>
            <div id="btnEditGroup" class="mt-3">
              <button class="btn btn-primary btn-sm px-4" onclick="editDetail()">แก้ไขข้อมูล</button>
            </div>
            <div id="btnSaveGroup" class="mt-3 d-none">
              <button class="btn btn-success btn-sm px-4 me-1" onclick="saveDetail('${safeIdForSave}')">บันทึก</button>
              <button class="btn btn-secondary btn-sm px-4" onclick="viewDetail('${safeIdForSave}')">ยกเลิก</button>
            </div>
          </div>
          <div class="col-md-4">
            <div class="edit-mode d-none x-small">
              <p class="fw-bold text-danger border-bottom mb-2">อัปโหลดเอกสารใหม่:</p>
              <div class="mb-2"><label>1. รูปพนักงาน:</label><input type="file" id="up_profile" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>2. Passport:</label><input type="file" id="up_passport" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>3. Visa:</label><input type="file" id="up_visa" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>4. Work Permit:</label><input type="file" id="up_workpermit" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>5. เอกสารอื่นๆ:</label><input type="file" id="up_other5" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>6. เอกสารอื่นๆ:</label><input type="file" id="up_other6" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>7. เอกสารอื่นๆ:</label><input type="file" id="up_other7" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>8. เอกสารอื่นๆ:</label><input type="file" id="up_other8" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>9. เอกสารอื่นๆ:</label><input type="file" id="up_other9" class="form-control form-control-sm" accept="image/*"></div>
              <div class="mb-2"><label>10. เอกสารอื่นๆ:</label><input type="file" id="up_other10" class="form-control form-control-sm" accept="image/*"></div>
            </div>
          </div>
        </div>
        <div class="row mt-4 view-mode text-center border-top pt-3">
          <div class="col-3"><p class="x-small fw-bold">รูปพนักงาน</p><img src="${photos.profile}" class="img-fluid border shadow-sm img-hover" style="max-height: 100px; cursor: pointer;" onclick="showFullImage('${photos.profile}')"></div>
          <div class="col-3"><p class="x-small fw-bold">Passport</p><img src="${photos.passport}" class="img-fluid border shadow-sm img-hover" style="max-height: 100px; cursor: pointer;" onclick="showFullImage('${photos.passport}')"></div>
          <div class="col-3"><p class="x-small fw-bold">Visa</p><img src="${photos.visa}" class="img-fluid border shadow-sm img-hover" style="max-height: 100px; cursor: pointer;" onclick="showFullImage('${photos.visa}')"></div>
          <div class="col-3"><p class="x-small fw-bold">Work Permit</p><img src="${photos.workpermit}" class="img-fluid border shadow-sm img-hover" style="max-height: 100px; cursor: pointer;" onclick="showFullImage('${photos.workpermit}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">5. เอกสารอื่นๆ</p><img src="${photos.other5}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other5}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">6. เอกสารอื่นๆ</p><img src="${photos.other6}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other6}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">7. เอกสารอื่นๆ</p><img src="${photos.other7}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other7}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">8. เอกสารอื่นๆ</p><img src="${photos.other8}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other8}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">9. เอกสารอื่นๆ</p><img src="${photos.other9}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other9}')"></div>
          <div class="col-6 col-md-2"><p class="x-small fw-bold mb-1">10. เอกสารอื่นๆ</p><img src="${photos.other10}" class="img-fluid border shadow-sm img-hover" style="max-height: 90px; cursor: pointer;" onclick="showFullImage('${photos.other10}')"></div>
        </div>
        </div>
      </div>
      <div class="bg-dark text-white p-2 text-center rounded-top small fw-bold">ประวัติการทำงาน (Work History)</div>
    `;

    document.getElementById("modalContent").innerHTML = contentHtml;
    const modalEl = document.getElementById("detailModal");
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  } finally {
    toggleLoader(false);
  }
}

function editDetail() {
  document.querySelectorAll(".view-mode").forEach(el => el.classList.add("d-none"));
  document.querySelectorAll(".edit-mode").forEach(el => el.classList.remove("d-none"));
  document.getElementById("btnEditGroup").classList.add("d-none");
  document.getElementById("btnSaveGroup").classList.remove("d-none");
}

// =========================================================================
// 💾 5. บันทึกแก้ไขข้อมูล + อัปโหลดรูปภาพลง Firebase Storage & Firestore
// =========================================================================
async function saveDetail(empId) {
  const newData = {
    pid: document.getElementById("edit_pid").value.trim(),
    name: document.getElementById("edit_name").value.trim(),
    nick: document.getElementById("edit_nick").value.trim(),
    work: document.getElementById("edit_work").value.trim(),
    employer: document.getElementById("edit_employer").value,
    section: document.getElementById("edit_section").value.trim(),
    position: document.getElementById("edit_position").value.trim(),
    salary: document.getElementById("edit_salary").value,
    ssSalary: document.getElementById("edit_ssSalary").value,
    socialSec: document.getElementById("edit_socialSec").checked,
    housingType: document.getElementById("edit_housingType").value,
    housingDetail: document.getElementById("edit_housingDetail").value.trim(),
    accommodationCost: document.getElementById("edit_accommodationCost").value,
    subsidy: document.getElementById("edit_subsidy").value
  };

  if (!empId || empId === "-") {
    alert("ไม่พบรหัสพนักงาน (ID) ไม่สามารถบันทึกข้อมูลได้");
    return;
  }

  const fileTasks = [
    { id: "up_profile", suffix: "" },
    { id: "up_passport", suffix: "-passport" },
    { id: "up_visa", suffix: "-visa" },
    { id: "up_workpermit", suffix: "-workpermit" },
    { id: "up_other5", suffix: "-other5" },
    { id: "up_other6", suffix: "-other6" },
    { id: "up_other7", suffix: "-other7" },
    { id: "up_other8", suffix: "-other8" },
    { id: "up_other9", suffix: "-other9" },
    { id: "up_other10", suffix: "-other10" }
  ];

  const currentUser = window.currentUser || "System";
  toggleLoader(true);

  try {
    // 1. อัปโหลดรูปภาพที่มีการเลือกไฟล์ใหม่ทีละรายการ
    for (const task of fileTasks) {
      const input = document.getElementById(task.id);
      if (input && input.files.length > 0) {
        const file = input.files[0];
        const ext = file.name.split(".").pop().toLowerCase() || "png";
        const fileNameToSave = `${empId}${task.suffix}.${ext}`;
        await uploadPhoto(file, fileNameToSave, currentUser);
      }
    }

    // 2. อัปเดตข้อมูลฟิลด์พนักงานลง Firestore
    await updateEmployeeData(empId, newData, currentUser);

    // 3. โหลดข้อมูลใหม่และปิด Modal
    rawData = await getEmployeeData();
    populateFilterDropdowns(rawData);
    filterData();

    const detailModalInst = bootstrap.Modal.getInstance(document.getElementById("detailModal"));
    if (detailModalInst) detailModalInst.hide();

    toggleLoader(false);
    bootstrap.Modal.getOrCreateInstance(document.getElementById("successModal")).show();
  } catch (err) {
    toggleLoader(false);
    alert("เกิดข้อผิดพลาดในการบันทึกข้อมูล: " + err.message);
  }
}

async function updateEmployeeData(empId, newData, userProfile) {
  const safeUser = userProfile || "System";

  try {
    if (!empId) throw new Error("ไม่ได้ระบุ ID พนักงานที่ต้องการแก้ไข");
    const cleanEmpId = String(empId).trim().padStart(4, "0");
    const empRef = doc(db, "hr", cleanEmpId);

    // 🎯 1. ดึงข้อมูลเอกสารพนักงานล่าสุดจาก Firestore เพื่อเช็กค่า pid เดิมก่อนบันทึก
    const currentSnap = await getDoc(empRef);
    const currentData = currentSnap.exists() ? (currentSnap.data() || {}) : {};
    const existingPid = currentData.pid ?? currentData.profile?.pid ?? "";

    // กำหนดค่า finalPid (ใช้ค่าใหม่ที่กรอก แต่ถ้าเว้นว่างให้คงค่า pid เดิมไว้)
    const rawPid = newData.pid !== undefined ? String(newData.pid) : String(existingPid);
    const finalPid = rawPid
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .join(",");

    // 2. คำนวณเงินเดือนและประกันสังคม
    const salary = Number(newData.salary || 0);
    const ssSalary = Number(newData.ssSalary || 0);
    const isSocialSec = newData.socialSec === true || newData.socialSec === "true";

    let employeeContribution = 0;
    let employerContribution = 0;

    if (isSocialSec && ssSalary > 0) {
      const baseSalary = Math.min(Math.max(ssSalary, 1650), 17500);
      employeeContribution = Math.round(baseSalary * 0.05);
      employerContribution = Math.round(baseSalary * 0.05);
    }

    // 3. ประกอบข้อมูลสำหรับอัปเดตลง Firestore
    const updatePayload = {
      pid: finalPid,
      profile: {
        name: newData.name || "",
        nickname: newData.nick || ""
      },
      employment: {
        shop: newData.work || "",
        employer: newData.employer || "",
        section: newData.section || "",
        position: newData.position || "",
        salary: salary
      },
      welfare: {
        social_security: isSocialSec,
        ss_salary: ssSalary,
        Employee_Contribution: employeeContribution,
        Employer_Contribution: employerContribution,
        housing: {
          type: newData.housingType || "",
          detail: newData.housingDetail || "",
          accommodation_cost: Number(newData.accommodationCost) || 0,
          subsidy: Number(newData.subsidy) || 0
        }
      },
      system: {
        updated_at: new Date().toISOString()
      }
    };

await setDoc(empRef, updatePayload, { merge: true });

    await insertAuditLog(
      "EDIT_HR_SUCCESS",
      `แก้ไขข้อมูลพนักงานรหัส ${cleanEmpId} (PID: ${finalPid || "-"}, ชื่อ: ${newData.name || ""}) เรียบร้อย`,
      safeUser
    );

    return "บันทึกเรียบร้อย";
  } catch (e) {
    console.error("Error updateEmployeeData:", e);
    await insertAuditLog(
      "EDIT_HR_FAILED",
      `❌ แก้ไขข้อมูลพนักงานล้มเหลว (ID: ${empId || "ไม่ระบุ"}) | สาเหตุ: ${e.message}`,
      safeUser
    );
    throw e;
  }
}

async function uploadPhoto(fileObj, fileName, userProfile) {
  const safeUser = userProfile || "System";
  let empId = "Unknown";
  let targetField = "profile_image_drive";

  try {
    if (!fileObj || !fileName) {
      throw new Error("ข้อมูลไฟล์รูปภาพหรือชื่อไฟล์ไม่ถูกต้อง");
    }

    const cleanFileName = fileName.toLowerCase().trim();
    const idMatch = cleanFileName.match(/\d+/);
    if (!idMatch) {
      throw new Error("ชื่อไฟล์ไม่ตรงตามรูปแบบที่มีรหัสพนักงาน (เช่น 9164, 0001)");
    }

    empId = String(idMatch[0]).padStart(4, "0");

    if (cleanFileName.includes("passport")) targetField = "passport_image_drive";
    else if (cleanFileName.includes("visa")) targetField = "visa_image_drive";
    else if (cleanFileName.includes("workpermit") || cleanFileName.includes("wp")) targetField = "work_permit_image_drive";
    else if (cleanFileName.includes("other10")) targetField = "other_10_image_drive";
    else if (cleanFileName.includes("other5")) targetField = "other_5_image_drive";
    else if (cleanFileName.includes("other6")) targetField = "other_6_image_drive";
    else if (cleanFileName.includes("other7")) targetField = "other_7_image_drive";
    else if (cleanFileName.includes("other8")) targetField = "other_8_image_drive";
    else if (cleanFileName.includes("other9")) targetField = "other_9_image_drive";

    const storagePath = `hr_attachments/${empId}/${cleanFileName}`;
    const fileRef = ref(storage, storagePath);

    await uploadBytes(fileRef, fileObj);
    const downloadUrl = await getDownloadURL(fileRef);

    await setDoc(
      doc(db, "hr", empId),
      { attachments: { [targetField]: downloadUrl } },
      { merge: true }
    );

    await insertAuditLog(
      "UPLOAD_PHOTO_SUCCESS",
      `อัปโหลดรูปภาพพนักงานรหัส ${empId} สำเร็จ (ฟิลด์: ${targetField})`,
      safeUser
    );

    return downloadUrl;
  } catch (e) {
    console.error("Error uploadPhoto:", e);
    await insertAuditLog(
      "UPLOAD_PHOTO_FAILED",
      `❌ อัปโหลดรูปภาพล้มเหลว (พนักงานรหัส: ${empId}, ไฟล์: ${fileName}) | สาเหตุ: ${e.message}`,
      safeUser
    );
    throw e;
  }
}

// =========================================================================
// 🛠️ Helper Functions
// =========================================================================
function printPDF() {
  window.print();
}

function showFullImage(url) {
  const previewImg = document.getElementById("fullImagePreview");
  if (url && !url.startsWith("data:image/svg+xml")) {
    previewImg.src = url;
    bootstrap.Modal.getOrCreateInstance(document.getElementById("imagePreviewModal")).show();
  }
}

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

// ผูกฟังก์ชันเข้า window สำหรับเรียกใช้จาก HTML onclick / onkeyup
window.filterData = filterData;
window.viewDetail = viewDetail;
window.editDetail = editDetail;
window.saveDetail = saveDetail;
window.printPDF = printPDF;
window.showFullImage = showFullImage;