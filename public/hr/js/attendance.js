// public/hr/js/attendance.js
import { db } from "../../js/firestore.js";
import { insertAuditLog, initHRPageSession } from "./hr-log.js";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const VALID_STATUSES = [
  "Full",
  "Half",
  "Sick",
  "Off",
  "Absent",
  "Late",
  "Leave",
  "Extra Day",
  "Full/PH",
  "Half/PH",
  "Without Pay"
];

const BLOCK_STATUS_LIST = ["Sick", "Off", "Absent", "Leave", "Without Pay"];

window.attendancePresets = [];
window.lastSelectedGroupId = "ALL";

// =========================================================================
// 🚀 1. เริ่มต้นทำงาน โหลดกลุ่ม Preset และตารางเวลาทำงานของวันนี้
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  initFloatingInsertListeners();

  // ตั้งค่าวันที่เริ่มต้นเป็นวันนี้ (รูปแบบ YYYY-MM-DD ตามเวลาไทย)
  const attDateInput = document.getElementById("attDate");
  if (attDateInput && !attDateInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    attDateInput.value = `${yyyy}-${mm}-${dd}`;
  }

  await loadGroupPresets();
  await renderAttendanceGrid();
});

// =========================================================================
// 📊 2. ดึงข้อมูลพนักงานและประวัติลงเวลาจาก Firestore มาสร้างตาราง
// =========================================================================
async function renderAttendanceGrid() {
  const date = document.getElementById("attDate").value;
  const tableBody = document.getElementById("attendanceGridBody");
  const saveBtn = document.getElementById("btnSaveAttendance");

  if (!date) {
    tableBody.innerHTML = `<tr><td colspan="13" class="text-center text-muted py-4">กรุณาเลือกวันที่ปฏิบัติงาน</td></tr>`;
    saveBtn.classList.add("d-none");
    return;
  }

  toggleLoader(true);

  try {
    const data = await getAttendanceGridData(date);

    if (!data || data.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="13" class="text-center py-4 text-muted">ไม่พบข้อมูลพนักงานในวันที่เลือก</td></tr>`;
      saveBtn.classList.add("d-none");
      return;
    }

    let html = "";
    saveBtn.classList.remove("d-none");

    data.forEach(emp => {
      let rawStatus = emp.status || "Full";
      let mainStatus = rawStatus;
      let lateType = "Full";

      if (rawStatus.startsWith("Late")) {
        mainStatus = "Late";
        if (rawStatus.includes("Half")) {
          lateType = "Half";
        }
      }

      const lateMinutes = emp.late_minutes !== undefined ? emp.late_minutes : 0;
      const scanIssue = emp.scan_issue || "";

      const statusOptionsHtml = VALID_STATUSES.map(st => {
        const isSelected = mainStatus === st ? "selected" : "";
        return `<option value="${st}" ${isSelected}>${st}</option>`;
      }).join("");

      const isBlock = BLOCK_STATUS_LIST.includes(mainStatus);
      const bgStyle = isBlock ? "background-color: #f8d7da; color: #842029; border-color: #f5c2c7;" : "";
      const isReadOnly = isBlock ? "readonly" : "";

      const normalizedShop = normalizeShopValue(emp.today_work || emp.shop || "");

      const statusBadgeHtml = emp.review_status === "reviewed"
        ? `<div class="x-small fw-bold text-success mt-1" style="font-size: 0.65rem; letter-spacing: 0.3px;"><i class="bi bi-check-circle-fill"></i> Reviewed</div>`
        : `<div class="x-small fw-bold text-warning mt-1" style="font-size: 0.65rem; letter-spacing: 0.3px;"><i class="bi bi-clock-history"></i> Pending</div>`;

      const in1 = emp.check_in1 || "";
      const out1 = emp.check_out1 || "";
      const in2 = emp.check_in2 || "";
      const out2 = emp.check_out2 || "";

      const displayLateMenu = mainStatus === "Late" ? "" : "d-none";

      html += `
        <tr class="attendance-row"
          data-emp-id="${escapeHtml(emp.employee_id)}"
          data-emp-name="${escapeHtml(emp.name)}"
          data-emp-nick="${escapeHtml(emp.nickname)}"
          data-main-shop="${escapeHtml(normalizeShopValue(emp.shop || ""))}"
          data-orig-in1="${escapeHtml(in1)}"
          data-orig-out1="${escapeHtml(out1)}"
          data-orig-in2="${escapeHtml(in2)}"
          data-orig-out2="${escapeHtml(out2)}"
          data-orig-ot="${emp.ot_hours !== undefined ? emp.ot_hours : 0}">
          <td class="fw-bold text-secondary align-middle">
            <div>${escapeHtml(emp.employee_id)}</div>
            ${statusBadgeHtml}
          </td>
          <td class="text-start fw-bold text-dark text-truncate">${escapeHtml(emp.name)}</td>
          <td class="text-muted text-truncate">${escapeHtml(emp.nickname)}</td>
          <td class="text-start text-muted text-truncate">${escapeHtml(emp.position)}</td>
          <td class="align-middle">
            <select class="form-select form-select-sm att-status fw-bold text-center" onchange="handleStatusChange(this)">
              ${statusOptionsHtml}
            </select>

            <div class="att-late-type-container mt-1 ${displayLateMenu}">
              <select class="form-select form-select-sm att-late-type text-center bg-light text-danger fw-bold" style="font-size: 0.75rem;">
                <option value="Full" ${lateType === "Full" ? "selected" : ""}>Full</option>
                <option value="Half" ${lateType === "Half" ? "selected" : ""}>Half</option>
              </select>
              <div class="input-group input-group-sm mt-1" style="max-width: 90px; margin: 0 auto;">
                <input type="number" class="form-control text-center att-late-minutes fw-bold text-danger" value="${lateMinutes}" placeholder="นาที" min="0" style="font-size: 0.75rem;">
                <span class="input-group-text px-1" style="font-size: 0.65rem;">นาที</span>
              </div>
            </div>
          </td>

          <td><input type="text" class="form-control form-control-sm text-center att-in1" value="${escapeHtml(in1)}" style="${bgStyle}" ${isReadOnly} onblur="formatTimeInput(this)"></td>
          <td><input type="text" class="form-control form-control-sm text-center att-out1" value="${escapeHtml(out1)}" style="${bgStyle}" ${isReadOnly} onblur="formatTimeInput(this)"></td>
          <td><input type="text" class="form-control form-control-sm text-center att-in2" value="${escapeHtml(in2)}" style="${bgStyle}" ${isReadOnly} onblur="formatTimeInput(this)"></td>
          <td><input type="text" class="form-control form-control-sm text-center att-out2" value="${escapeHtml(out2)}" style="${bgStyle}" ${isReadOnly} onblur="formatTimeInput(this)"></td>

          <td><input type="number" step="0.5" class="form-control form-control-sm text-center att-ot" value="${emp.ot_hours}" style="${bgStyle}" ${isReadOnly}></td>

          <td>
            <select class="form-select form-select-sm att-scan-issue mb-1 fw-bold text-danger" style="font-size: 0.75rem; background-color: #fff6f6;">
              <option value="" ${scanIssue === "" ? "selected" : ""}>-- สแกนปกติ --</option>
              <option value="No scan-in" ${scanIssue === "No scan-in" ? "selected" : ""}>No scan-in</option>
              <option value="No scan-out" ${scanIssue === "No scan-out" ? "selected" : ""}>No scan-out</option>
              <option value="Early Check-out" ${scanIssue === "Early Check-out" ? "selected" : ""}>Early Check-out</option>
            </select>
            <input type="text" class="form-control form-control-sm text-start att-remarks" value="${escapeHtml(emp.remarks || "")}" placeholder="ระบุหมายเหตุ...">
          </td>

          <td>
            <select class="form-select form-select-sm fw-bold att-today-work text-primary" style="background-color: #f0f5ff;" onchange="applyAttendanceFilters()">
              ${buildShopOptionsHtml(normalizedShop)}
            </select>
          </td>
          <td>
            <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2" onclick="removeAttRowTemporarily(this)">
              <i class="bi bi-trash"></i> ลบ
            </button>
          </td>
        </tr>
      `;
    });

    tableBody.innerHTML = html;
    applyAttendanceFilters();

    const groupPresetSelect = document.getElementById("attGroupPreset");
    if (groupPresetSelect && groupPresetSelect.value !== "ALL") {
      onGroupPresetChange();
    }
  } catch (err) {
    console.error("Error renderAttendanceGrid:", err);
    alert("ระบบดึงข้อมูลจากคลาวด์ขัดข้อง: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

async function getAttendanceGridData(date) {
  if (!date) return [];

  // 1. ดึงข้อมูลพนักงานที่ยังทำงานอยู่ทั้งหมดจาก /hr
  const empSnap = await getDocs(collection(db, "hr"));
  const activeEmployees = [];
  const activeEmpIds = new Set();

  empSnap.forEach(docSnap => {
    const emp = docSnap.data() || {};
    const status = String(emp.status || emp.employment?.status || "").trim();
    const empShop = String(emp.shop || emp.workplace || emp.employment?.shop || emp.employment?.workplace || "").trim();

    if (status !== "out" && status !== "ออก") {
      const empId = String(emp.employee_id || emp.id || docSnap.id).trim().padStart(4, "0");
      const empName = emp.name || emp.personal_info?.name || emp.profile?.name || "-";
      const empNick = emp.nickname || emp.nick || emp.personal_info?.nickname || emp.profile?.nickname || "-";
      const empPos = emp.position || emp.employment?.position || emp.work?.position || "-";

      activeEmployees.push({
        employee_id: empId,
        name: empName,
        nickname: empNick,
        position: empPos,
        shop: empShop
      });
      activeEmpIds.add(empId);
    }
  });

  activeEmployees.sort((a, b) => a.employee_id.localeCompare(b.employee_id));
  if (activeEmployees.length === 0) return [];

  // 2. ดึงข้อมูล attendance_logs ประจำวันที่เลือกผ่าน Collection Group Query
  const logsMap = {};
  try {
    const logsQuery = query(
      collectionGroup(db, "attendance_logs"),
      where("date", "==", date)
    );
    const logsSnap = await getDocs(logsQuery);

    logsSnap.forEach(logDoc => {
      const parentEmpDoc = logDoc.ref.parent.parent;
      const empId = parentEmpDoc ? String(parentEmpDoc.id).padStart(4, "0") : "";
      if (empId && activeEmpIds.has(empId)) {
        logsMap[empId] = parseAttendanceLogData(logDoc.data());
      }
    });
  } catch (cgErr) {
    // Fallback: กรณี Firestore ยังไม่ได้เปิด Collection Group Index ให้ดึงรายเอกสารตรงๆ แบบขนาน
    console.warn("Fallback to direct attendance_logs fetch:", cgErr.message);
    await Promise.all(
      activeEmployees.map(async emp => {
        try {
          const logSnap = await getDoc(doc(db, "hr", emp.employee_id, "attendance_logs", date));
          if (logSnap.exists()) {
            logsMap[emp.employee_id] = parseAttendanceLogData(logSnap.data());
          }
        } catch (e) {
          console.error(`Error fetching log for ${emp.employee_id}:`, e);
        }
      })
    );
  }

  // 3. รวมข้อมูลพนักงานเข้ากับประวัติเวลาทำงาน
  return activeEmployees.map(emp => {
    const attLog = logsMap[emp.employee_id] || {
      status: "Full",
      late_minutes: 0,
      scan_issue: "",
      check_in1: "",
      check_out1: "",
      check_in2: "",
      check_out2: "",
      ot_hours: 0,
      remarks: "",
      today_work: "",
      review_status: "pending"
    };

    return {
      ...emp,
      ...attLog
    };
  });
}

function parseAttendanceLogData(logFields = {}) {
  return {
    status: logFields.status !== undefined ? String(logFields.status) : "Full",
    late_minutes: logFields.late_minutes !== undefined ? Number(logFields.late_minutes) : 0,
    scan_issue: logFields.scan_issue !== undefined ? String(logFields.scan_issue) : "",
    check_in1: logFields.check_in1 !== undefined ? String(logFields.check_in1) : (logFields.check_in ? String(logFields.check_in) : ""),
    check_out1: logFields.check_out1 !== undefined ? String(logFields.check_out1) : (logFields.check_out ? String(logFields.check_out) : ""),
    check_in2: logFields.check_in2 !== undefined ? String(logFields.check_in2) : "",
    check_out2: logFields.check_out2 !== undefined ? String(logFields.check_out2) : "",
    ot_hours: logFields.ot_hours !== undefined ? Number(logFields.ot_hours) : 0,
    remarks: logFields.remarks !== undefined ? String(logFields.remarks) : (logFields.remark ? String(logFields.remark) : ""),
    today_work: logFields.today_work !== undefined ? String(logFields.today_work) : "",
    review_status: logFields.review_status !== undefined ? String(logFields.review_status) : "pending"
  };
}

// =========================================================================
// ⚙️ 3. จัดการสถานะเข้างาน (ล็อกช่องเวลาเมื่อขาด/ลา/หยุด, เปิดช่องนาทีสายเมื่อ Late)
// =========================================================================
function handleStatusChange(selectEl) {
  const row = selectEl.closest("tr.attendance-row");
  if (!row) return;

  const val = selectEl.value;
  const lateContainer = row.querySelector(".att-late-type-container");
  if (lateContainer) {
    if (val === "Late") {
      lateContainer.classList.remove("d-none");
    } else {
      lateContainer.classList.add("d-none");
    }
  }

  const isBlock = BLOCK_STATUS_LIST.includes(val);
  const timeInputs = row.querySelectorAll(".att-in1, .att-out1, .att-in2, .att-out2, .att-ot");

  timeInputs.forEach(inp => {
    inp.readOnly = isBlock;
    if (isBlock) {
      inp.style.backgroundColor = "#f8d7da";
      inp.style.color = "#842029";
      inp.style.borderColor = "#f5c2c7";
      inp.value = inp.classList.contains("att-ot") ? "0" : "";
    } else {
      inp.style.backgroundColor = "";
      inp.style.color = "";
      inp.style.borderColor = "";
    }
  });
}

function removeAttRowTemporarily(btnEl) {
  const row = btnEl.closest("tr.attendance-row");
  if (!row) return;
  row.classList.add("row-removed");
  row.style.display = "none";
}

// =========================================================================
// ➕ 4. ดึงตัวพนักงานข้ามสาขา & ระบบแทรกแถวกลางตาราง (Floating Insert)
// =========================================================================
async function pullEmployeeByNameToAttendanceGrid() {
  const targetName = document.getElementById("addExtraAttEmpName").value.trim().toLowerCase();
  if (!targetName) return alert("กรุณาระบุชื่อหรือชื่อเล่นพนักงานที่ต้องการดึงตัวก่อนครับ");

  const gridBody = document.getElementById("attendanceGridBody");
  const rows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
  let foundCount = 0;
  const currentGridShop = document.getElementById("attWorkplace").value;

  if (gridBody.querySelector("td[colspan]")) {
    gridBody.innerHTML = "";
  }

  rows.forEach(row => {
    const name = (row.getAttribute("data-emp-name") || "").toLowerCase();
    const nick = (row.getAttribute("data-emp-nick") || "").toLowerCase();

    if (name.includes(targetName) || nick.includes(targetName)) {
      foundCount++;
      row.classList.remove("row-removed");
      row.classList.add("explicitly-pulled");

      const todayWorkSelect = row.querySelector(".att-today-work");
      if (todayWorkSelect && currentGridShop !== "ALL") {
        todayWorkSelect.value = currentGridShop;
      }

      gridBody.appendChild(row);
    }
  });

  if (foundCount > 0) {
    applyAttendanceFilters();
    document.getElementById("addExtraAttEmpName").value = "";
    document.getElementById("btnSaveAttendance").classList.remove("d-none");
    return;
  }

  toggleLoader(true);
  try {
    const empProfile = await getEmployeeProfileByName(targetName);
    if (!empProfile) {
      return alert(`❌ ไม่พบชื่อหรือชื่อเล่น "${targetName}" ในสารบบฐานข้อมูลหลักครับ`);
    }

    const extraRowHtml = buildExtraEmployeeRowHtml(empProfile, currentGridShop, false);
    gridBody.insertAdjacentHTML("beforeend", extraRowHtml);
    document.getElementById("btnSaveAttendance").classList.remove("d-none");
    document.getElementById("addExtraAttEmpName").value = "";
    applyAttendanceFilters();
  } catch (err) {
    alert("ดึงข้อมูลพนักงานล้มเหลว: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

async function handleFloatingInsertClick() {
  const btn = document.getElementById("floatingInsertBtn");
  const targetEmpId = btn.getAttribute("data-target-id");
  const position = btn.getAttribute("data-position");

  const gridBody = document.getElementById("attendanceGridBody");
  const targetRow = gridBody.querySelector(`tr.attendance-row[data-emp-id="${targetEmpId}"]`);
  if (!targetRow) return;

  const targetName = prompt("➕ ระบุชื่อหรือชื่อเล่นพนักงานที่ต้องการแทรก ณ ตำแหน่งเส้นแบ่งนี้:");
  if (!targetName || !targetName.trim()) return;

  hideInsertIndicator();
  const currentGridShop = document.getElementById("attWorkplace").value;
  const rows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
  let foundCount = 0;

  rows.forEach(row => {
    const name = (row.getAttribute("data-emp-name") || "").toLowerCase();
    const nick = (row.getAttribute("data-emp-nick") || "").toLowerCase();

    if (name.includes(targetName.toLowerCase()) || nick.includes(targetName.toLowerCase())) {
      foundCount++;
      row.classList.remove("row-removed");
      row.classList.add("explicitly-pulled", "inline-inserted");

      const todayWorkSelect = row.querySelector(".att-today-work");
      if (todayWorkSelect && currentGridShop !== "ALL") todayWorkSelect.value = currentGridShop;

      if (position === "before") {
        gridBody.insertBefore(row, targetRow);
      } else {
        gridBody.insertBefore(row, targetRow.nextSibling);
      }
    }
  });

  if (foundCount > 0) {
    applyAttendanceFilters();
    return;
  }

  toggleLoader(true);
  try {
    const empProfile = await getEmployeeProfileByName(targetName);
    if (!empProfile) {
      return alert(`❌ ไม่พบชื่อหรือชื่อเล่น "${targetName}" ในสารบบฐานข้อมูลหลักครับ`);
    }

    const template = document.createElement("template");
    template.innerHTML = buildExtraEmployeeRowHtml(empProfile, currentGridShop, true).trim();
    const newRow = template.content.firstChild;

    if (position === "before") {
      gridBody.insertBefore(newRow, targetRow);
    } else {
      gridBody.insertBefore(newRow, targetRow.nextSibling);
    }

    document.getElementById("btnSaveAttendance").classList.remove("d-none");
    applyAttendanceFilters();
  } catch (err) {
    alert("ดึงข้อมูลพนักงานล้มเหลว: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

async function getEmployeeProfileByName(targetName) {
  if (!targetName) return null;
  const searchName = targetName.trim().toLowerCase();

  const empSnap = await getDocs(collection(db, "hr"));
  let foundEmp = null;

  empSnap.forEach(docSnap => {
    if (foundEmp) return;
    const emp = docSnap.data() || {};
    const status = String(emp.status || emp.employment?.status || "").trim();

    if (status !== "out" && status !== "ออก") {
      const rawName = emp.name || emp.personal_info?.name || emp.profile?.name || "-";
      const rawNick = emp.nickname || emp.nick || emp.personal_info?.nickname || emp.profile?.nickname || "-";

      if (rawName.toLowerCase().includes(searchName) || rawNick.toLowerCase().includes(searchName)) {
        foundEmp = {
          employee_id: String(emp.employee_id || emp.id || docSnap.id).trim().padStart(4, "0"),
          name: rawName,
          nickname: rawNick,
          position: emp.position || emp.employment?.position || emp.work?.position || "-",
          shop: String(emp.shop || emp.workplace || emp.employment?.shop || emp.employment?.workplace || "").trim()
        };
      }
    }
  });

  return foundEmp;
}

function buildExtraEmployeeRowHtml(empProfile, currentGridShop, isInline) {
  const targetDefaultShop = currentGridShop === "ALL"
    ? normalizeShopValue(empProfile.shop || "Atom")
    : currentGridShop;

  const statusBadgeHtml = `<div class="x-small fw-bold text-warning mt-1" style="font-size: 0.65rem; letter-spacing: 0.3px;"><i class="bi bi-clock-history"></i> Pending</div>`;
  const extraClass = isInline ? "explicitly-pulled inline-inserted" : "explicitly-pulled";

  const statusOptionsHtml = VALID_STATUSES.map(st =>
    `<option value="${st}" ${st === "Full" ? "selected" : ""}>${st}</option>`
  ).join("");

  return `
    <tr class="attendance-row ${extraClass}"
      data-emp-id="${escapeHtml(empProfile.employee_id)}"
      data-emp-name="${escapeHtml(empProfile.name)}"
      data-emp-nick="${escapeHtml(empProfile.nickname || "-")}"
      data-main-shop="${escapeHtml(normalizeShopValue(empProfile.shop || ""))}"
      data-orig-in1=""
      data-orig-out1=""
      data-orig-in2=""
      data-orig-out2=""
      data-orig-ot="0">
      <td class="fw-bold text-secondary align-middle"><div>${escapeHtml(empProfile.employee_id)}</div>${statusBadgeHtml}</td>
      <td class="text-start fw-bold text-dark text-truncate">${escapeHtml(empProfile.name)}</td>
      <td class="text-muted text-truncate">${escapeHtml(empProfile.nickname || "-")}</td>
      <td class="text-start text-muted text-truncate">${escapeHtml(empProfile.position || "-")}</td>
      <td class="align-middle">
        <select class="form-select form-select-sm att-status fw-bold text-center" onchange="handleStatusChange(this)">
          ${statusOptionsHtml}
        </select>
        <div class="att-late-type-container mt-1 d-none">
          <select class="form-select form-select-sm att-late-type text-center bg-light text-danger fw-bold" style="font-size: 0.75rem;">
            <option value="Full" selected>Full</option>
            <option value="Half">Half</option>
          </select>
          <div class="input-group input-group-sm mt-1" style="max-width: 90px; margin: 0 auto;">
            <input type="number" class="form-control text-center att-late-minutes fw-bold text-danger" value="0" placeholder="นาที" min="0" style="font-size: 0.75rem;">
            <span class="input-group-text px-1" style="font-size: 0.65rem;">นาที</span>
          </div>
        </div>
      </td>
      <td><input type="text" class="form-control form-control-sm text-center att-in1" value="" onblur="formatTimeInput(this)"></td>
      <td><input type="text" class="form-control form-control-sm text-center att-out1" value="" onblur="formatTimeInput(this)"></td>
      <td><input type="text" class="form-control form-control-sm text-center att-in2" value="" onblur="formatTimeInput(this)"></td>
      <td><input type="text" class="form-control form-control-sm text-center att-out2" value="" onblur="formatTimeInput(this)"></td>
      <td><input type="number" step="0.5" class="form-control form-control-sm text-center att-ot" value="0"></td>
      <td>
        <select class="form-select form-select-sm att-scan-issue mb-1 fw-bold text-danger" style="font-size: 0.75rem; background-color: #fff6f6;">
          <option value="" selected>-- สแกนปกติ --</option>
          <option value="No scan-in">No scan-in</option>
          <option value="No scan-out">No scan-out</option>
          <option value="Early Check-out">Early Check-out</option>
        </select>
        <input type="text" class="form-control form-control-sm text-start att-remarks" value="ย้ายมาช่วยงานวันนี้" placeholder="ระบุหมายเหตุ...">
      </td>
      <td>
        <select class="form-select form-select-sm fw-bold att-today-work text-danger" style="background-color: #fff2f2;" onchange="applyAttendanceFilters()">
          ${buildShopOptionsHtml(targetDefaultShop)}
        </select>
      </td>
      <td><button type="button" class="btn btn-outline-danger btn-sm py-0 px-2" onclick="removeAttRowTemporarily(this)"><i class="bi bi-trash"></i> ลบ</button></td>
    </tr>
  `;
}

function initFloatingInsertListeners() {
  const container = document.getElementById("attendanceTableContainer");
  const gridBody = document.getElementById("attendanceGridBody");
  const btn = document.getElementById("floatingInsertBtn");
  const line = document.getElementById("floatingInsertLine");

  if (!gridBody || !container || !btn || !line) return;

  gridBody.addEventListener("mousemove", e => {
    const row = e.target.closest("tr.attendance-row");
    if (!row || row.style.display === "none" || row.classList.contains("row-removed")) {
      hideInsertIndicator();
      return;
    }

    const rect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const rowHeight = rect.height;

    let insertY = 0;
    let position = "before";

    if (relativeY < rowHeight / 2) {
      insertY = rect.top - containerRect.top + container.scrollTop;
      position = "before";
    } else {
      insertY = rect.bottom - containerRect.top + container.scrollTop;
      position = "after";
    }

    btn.style.top = insertY + "px";
    btn.classList.remove("d-none");
    btn.classList.add("d-flex");

    line.style.top = insertY + "px";
    line.classList.remove("d-none");

    btn.setAttribute("data-target-id", row.getAttribute("data-emp-id"));
    btn.setAttribute("data-position", position);
  });

  container.addEventListener("mouseleave", hideInsertIndicator);
}

function hideInsertIndicator() {
  const btn = document.getElementById("floatingInsertBtn");
  const line = document.getElementById("floatingInsertLine");
  if (btn) {
    btn.classList.add("d-none");
    btn.classList.remove("d-flex");
  }
  if (line) line.classList.add("d-none");
}

// =========================================================================
// 📋 5. ระบบกลุ่มพนักงาน (Preset Group) และตัวกรองหน้าจอ
// =========================================================================
async function loadGroupPresets() {
  try {
    const snap = await getDocs(collection(db, "attendance_groups"));
    const presets = [];
    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      presets.push({
        id: docSnap.id,
        group_name: d.group_name || docSnap.id,
        employee_ids: Array.isArray(d.employee_ids) ? d.employee_ids : [],
        workplaces: d.workplaces || {}
      });
    });

    presets.sort((a, b) => a.group_name.localeCompare(b.group_name, "th"));
    window.attendancePresets = presets;

    const selectEl = document.getElementById("attGroupPreset");
    if (selectEl) {
      const prevVal = selectEl.value;
      selectEl.innerHTML =
        `<option value="ALL">-- แสดงรายชื่อทั้งหมดตามปกติ (ไม่มีกลุ่ม) --</option>` +
        presets
          .map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.group_name)} (${g.employee_ids.length} คน)</option>`)
          .join("");

      if (prevVal && presets.some(g => g.id === prevVal)) {
        selectEl.value = prevVal;
      }
    }
  } catch (e) {
    console.error("Error loadGroupPresets:", e);
  }
}

function onGroupPresetChange() {
  const selectedGroupId = document.getElementById("attGroupPreset").value;
  const gridBody = document.getElementById("attendanceGridBody");

  const allRows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
  allRows.forEach(r => r.classList.remove("explicitly-pulled", "inline-inserted"));

  let groupEmpIds = null;
  let groupWorkplaces = null;

  if (selectedGroupId && selectedGroupId !== "ALL" && window.attendancePresets) {
    const foundGroup = window.attendancePresets.find(g => g.id === selectedGroupId);
    if (foundGroup) {
      groupEmpIds = foundGroup.employee_ids;
      groupWorkplaces = foundGroup.workplaces;
    }
  }

  if (groupEmpIds && groupEmpIds.length > 0) {
    groupEmpIds.forEach(empId => {
      const cleanId = String(empId).padStart(4, "0");
      const row = gridBody.querySelector(`tr.attendance-row[data-emp-id="${cleanId}"]`);
      if (row) {
        gridBody.appendChild(row);
        if (groupWorkplaces && groupWorkplaces[cleanId]) {
          const todayWorkSelect = row.querySelector(".att-today-work");
          if (todayWorkSelect) todayWorkSelect.value = normalizeShopValue(groupWorkplaces[cleanId]);
        }
      }
    });
  }
  applyAttendanceFilters();
}

async function saveCurrentLayoutAsGroup() {
  const rows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
  const visibleEmpIds = [];
  const workplacesMap = {};

  rows.forEach(row => {
    if (!row.classList.contains("row-removed") && row.style.display !== "none") {
      const empId = String(row.getAttribute("data-emp-id")).padStart(4, "0");
      visibleEmpIds.push(empId);

      const todayWorkSelect = row.querySelector(".att-today-work");
      if (todayWorkSelect) {
        workplacesMap[empId] = todayWorkSelect.value;
      }
    }
  });

  if (visibleEmpIds.length === 0) {
    return alert("ไม่พบรายชื่อพนักงานบนตารางหน้าจอที่จะนำมาจัดกลุ่มครับ");
  }

  const groupSelect = document.getElementById("attGroupPreset");
  let currentGroupName = "";
  if (groupSelect && groupSelect.value !== "ALL") {
    const selectedOption = groupSelect.options[groupSelect.selectedIndex];
    currentGroupName = selectedOption.text.split(" (")[0];
  }

  const groupName = prompt(
    `📋 ระบุชื่อกลุ่มพนักงานที่ต้องการจัดกลุ่ม (ระบบจะบันทึกรายชื่อจำนวน ${visibleEmpIds.length} คนเรียงตามลำดับหน้าจอนี้):`,
    currentGroupName
  );
  if (!groupName || !groupName.trim()) return;

  const cleanGroupName = groupName.trim();
  const groupId = cleanGroupName.replace(/\s+/g, "_");
  const safeUser = window.currentUser || "System";

  toggleLoader(true);
  try {
    await setDoc(
      doc(db, "attendance_groups", groupId),
      {
        group_name: cleanGroupName,
        employee_ids: visibleEmpIds,
        workplaces: workplacesMap,
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );

    await insertAuditLog(
      "ATTENDANCE_GROUP_SUCCESS",
      `สร้าง/แก้ไขกลุ่มลงเวลาทำงาน ชื่อกลุ่ม: "${cleanGroupName}" (จำนวนสมาชิก: ${visibleEmpIds.length} คน)`,
      safeUser
    );

    alert(`🎉 บันทึกกลุ่มพนักงาน "${cleanGroupName}" พร้อมจำค่าสถานที่ทำงานแยกรายคนสำเร็จเรียบร้อย!`);
    await loadGroupPresets();
    if (groupSelect) groupSelect.value = groupId;
  } catch (err) {
    console.error("Error saveCurrentLayoutAsGroup:", err);
    await insertAuditLog(
      "ATTENDANCE_GROUP_FAILED",
      `❌ บันทึกกลุ่มพนักงานล้มเหลว (ชื่อกลุ่ม: ${cleanGroupName}) | สาเหตุ: ${err.message}`,
      safeUser
    );
    alert("เกิดข้อผิดพลาดในการเซฟกลุ่ม: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

function filterAttendanceByMainShop() {
  applyAttendanceFilters();
}

function filterAttNameInTable() {
  applyAttendanceFilters();
}

function applyAttendanceFilters() {
  const selectedShop = document.getElementById("attWorkplace").value;
  const searchText = document.getElementById("searchAttNameInput").value.trim().toLowerCase();
  const selectedGroupId = document.getElementById("attGroupPreset") ? document.getElementById("attGroupPreset").value : "ALL";

  if (window.lastSelectedGroupId !== selectedGroupId) {
    const allRows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
    allRows.forEach(r => r.classList.remove("explicitly-pulled", "inline-inserted"));
    window.lastSelectedGroupId = selectedGroupId;
  }

  let groupEmpIds = null;
  if (selectedGroupId && selectedGroupId !== "ALL" && window.attendancePresets) {
    const foundGroup = window.attendancePresets.find(g => g.id === selectedGroupId);
    if (foundGroup) {
      groupEmpIds = foundGroup.employee_ids.map(id => String(id).padStart(4, "0"));
    }
  }

  const rows = document.querySelectorAll("#attendanceTableContainer tr.attendance-row");

  rows.forEach(row => {
    if (row.classList.contains("row-removed")) {
      row.style.display = "none";
      return;
    }

    const empId = String(row.getAttribute("data-emp-id") || "").padStart(4, "0");
    const mainShop = row.getAttribute("data-main-shop") || "";
    const name = (row.getAttribute("data-emp-name") || "").toLowerCase();
    const nick = (row.getAttribute("data-emp-nick") || "").toLowerCase();
    const isExplicitlyPulled = row.classList.contains("explicitly-pulled");
    const isInlineInserted = row.classList.contains("inline-inserted");

    const todayWorkSelect = row.querySelector(".att-today-work");
    const todayWork = todayWorkSelect ? todayWorkSelect.value : "";

    const matchesGroup = !groupEmpIds || groupEmpIds.includes(empId) || isExplicitlyPulled || isInlineInserted;
    const matchesShop = groupEmpIds || isExplicitlyPulled || isInlineInserted
      ? true
      : selectedShop === "ALL" || mainShop === selectedShop || todayWork === selectedShop;
    const matchesName = !searchText || name.includes(searchText) || nick.includes(searchText);

    row.style.display = matchesGroup && matchesShop && matchesName ? "" : "none";
  });
}

// =========================================================================
// ⚡ 6. ตั้งค่าเวลาด่วน & บันทึกข้อมูลทั้งหมดลง Firestore (Batch Write)
// =========================================================================
function formatTimeInput(el) {
  if (!el.value || el.value === "-") return;
  let val = el.value.trim().replace(".", ":");
  if (val.length === 4 && !val.includes(":")) {
    val = val.substring(0, 2) + ":" + val.substring(2);
  }
  el.value = val;
}

function applyBulkTimesToGrid() {
  const bIn1 = document.getElementById("bulkIn1").value.trim();
  const bOut1 = document.getElementById("bulkOut1").value.trim();
  const bIn2 = document.getElementById("bulkIn2").value.trim();
  const bOut2 = document.getElementById("bulkOut2").value.trim();

  const rows = document.querySelectorAll("#attendanceGridBody tr.attendance-row");
  let updatedCount = 0;

  if (rows.length === 0 || document.querySelector("#attendanceGridBody td[colspan]")) {
    return alert("ไม่พบรายชื่อพนักงานในตารางที่จะให้ส่งค่าเวลาไปกรอกครับ");
  }

  rows.forEach(row => {
    if (row.style.display === "none" || row.classList.contains("row-removed")) return;

    const in1Input = row.querySelector(".att-in1");
    const out1Input = row.querySelector(".att-out1");
    const in2Input = row.querySelector(".att-in2");
    const out2Input = row.querySelector(".att-out2");

    if (in1Input && !in1Input.readOnly) {
      in1Input.value = bIn1;
      if (out1Input) out1Input.value = bOut1;
      if (in2Input) in2Input.value = bIn2;
      if (out2Input) out2Input.value = bOut2;
      updatedCount++;
    }
  });

  console.log(`⚡ [BULK TIME] ปรับปรุงเวลาด่วนเรียบร้อยพนักงานจำนวน ${updatedCount} คน`);
}

async function submitBatchAttendance() {
  const date = document.getElementById("attDate").value;
  if (!date) return alert("กรุณาระบุวันที่ต้องการบันทึกข้อมูลก่อนครับ");

  const rows = document.querySelectorAll(".attendance-row");
  const batchData = [];

  rows.forEach(row => {
    if (row.style.display === "none" || row.classList.contains("row-removed")) return;

    const empId = String(row.getAttribute("data-emp-id")).padStart(4, "0");
    const statusSelect = row.querySelector(".att-status");
    let currentStatus = statusSelect ? statusSelect.value : "Full";

    if (currentStatus === "Late") {
      const lateTypeSelect = row.querySelector(".att-late-type");
      const lateTypeVal = lateTypeSelect ? lateTypeSelect.value : "Full";
      currentStatus = `Late (${lateTypeVal})`;
    }

    const lateMinutesInput = row.querySelector(".att-late-minutes");
    const lateMinutesVal = currentStatus.startsWith("Late") && lateMinutesInput ? Number(lateMinutesInput.value) || 0 : 0;
    const scanIssueSelect = row.querySelector(".att-scan-issue");
    const scanIssueVal = scanIssueSelect ? scanIssueSelect.value : "";
    const todayWorkVal = row.querySelector(".att-today-work") ? row.querySelector(".att-today-work").value : "";
    const inputRemarks = row.querySelector(".att-remarks");
    const remarksVal = inputRemarks ? inputRemarks.value.trim() : "";

    batchData.push({
      employee_id: empId,
      date: date,
      status: currentStatus,
      today_work: todayWorkVal,
      check_in1: row.querySelector(".att-in1") ? row.querySelector(".att-in1").value.trim() : "",
      check_out1: row.querySelector(".att-out1") ? row.querySelector(".att-out1").value.trim() : "",
      check_in2: row.querySelector(".att-in2") ? row.querySelector(".att-in2").value.trim() : "",
      check_out2: row.querySelector(".att-out2") ? row.querySelector(".att-out2").value.trim() : "",
      ot_hours: row.querySelector(".att-ot") ? Number(row.querySelector(".att-ot").value) || 0 : 0,
      late_minutes: lateMinutesVal,
      scan_issue: scanIssueVal,
      remarks: remarksVal,
      remark: remarksVal
    });
  });

  if (batchData.length === 0) {
    return alert("ไม่มีรายการพนักงานที่แสดงอยู่บนตารางสำหรับบันทึก");
  }

  const safeUser = window.currentUser || "System";
  const recordCount = batchData.length;
  toggleLoader(true);

  try {
    // แบ่ง Chunk ละไม่เกิน 450 รายการ (เผื่อกรณีบันทึกพร้อมกันจำนวนมากตามลิมิต 500 writes/batch ของ Firestore)
    const CHUNK_SIZE = 450;
    for (let i = 0; i < batchData.length; i += CHUNK_SIZE) {
      const chunk = batchData.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      chunk.forEach(record => {
        const isLateStatus = record.status && record.status.startsWith("Late");
        if (!VALID_STATUSES.includes(record.status) && !isLateStatus) {
          throw new Error(`พบสถานะไม่ถูกต้อง: "${record.status}" (พนักงาน ID: ${record.employee_id})`);
        }

        const logRef = doc(db, "hr", record.employee_id, "attendance_logs", record.date);
        batch.set(
          logRef,
          {
            date: record.date,
            status: record.status,
            today_work: record.today_work,
            late_minutes: record.late_minutes,
            scan_issue: record.scan_issue,
            check_in1: record.check_in1,
            check_out1: record.check_out1,
            check_in2: record.check_in2,
            check_out2: record.check_out2,
            ot_hours: record.ot_hours,
            remarks: record.remarks,
            remark: record.remark,
            review_status: "reviewed",
            updated_at: new Date().toISOString()
          },
          { merge: true }
        );
      });

      await batch.commit();
    }

    await insertAuditLog(
      "ATTENDANCE_BATCH_SUCCESS",
      `บันทึก/อัปเดตเวลาทำงานแบบกลุ่มสำเร็จ จำนวน ${recordCount} รายการ (วันที่: ${date})`,
      safeUser
    );

    alert(`✅ บันทึกเวลาทำงานของพนักงาน (${recordCount} คน) เรียบร้อยแล้วครับ!`);
    await renderAttendanceGrid();
  } catch (err) {
    console.error("Error submitBatchAttendance:", err);
    await insertAuditLog(
      "ATTENDANCE_BATCH_FAILED",
      `❌ บันทึกล้มเหลว! (วันที่: ${date}, จำนวน: ${recordCount} รายการ) | สาเหตุ: ${err.message}`,
      safeUser
    );
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

// =========================================================================
// 🛠️ Helper Functions
// =========================================================================
function normalizeShopValue(shopStr) {
  const s = String(shopStr || "").trim();
  if (s === "Good Time") return "Good_Time";
  if (s === "Atom Beach") return "Atom_Beach";
  if (s === "Tiger") return "Tiger_King_Bar_&_Bistro";
  return s;
}

function buildShopOptionsHtml(selectedVal) {
  const shops = [
    { val: "Atom", label: "Atom" },
    { val: "Good_Time", label: "Good_Time" },
    { val: "Tiger_King_Bar_&_Bistro", label: "Tiger" },
    { val: "Paradise", label: "Paradise" },
    { val: "Atom_Beach", label: "Atom Beach" },
    { val: "ครัวกลาง", label: "ครัวกลาง" },
    { val: "Pizza", label: "Pizza" },
    { val: "Office", label: "Office" },
    { val: "Musician", label: "Musician" }
  ];
  return shops
    .map(item => `<option value="${item.val}" ${selectedVal === item.val ? "selected" : ""}>${item.label}</option>`)
    .join("");
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

// ผูกฟังก์ชันเข้า window สำหรับเรียกใช้จาก HTML
window.renderAttendanceGrid = renderAttendanceGrid;
window.filterAttendanceByMainShop = filterAttendanceByMainShop;
window.filterAttNameInTable = filterAttNameInTable;
window.pullEmployeeByNameToAttendanceGrid = pullEmployeeByNameToAttendanceGrid;
window.onGroupPresetChange = onGroupPresetChange;
window.saveCurrentLayoutAsGroup = saveCurrentLayoutAsGroup;
window.handleFloatingInsertClick = handleFloatingInsertClick;
window.handleStatusChange = handleStatusChange;
window.removeAttRowTemporarily = removeAttRowTemporarily;
window.formatTimeInput = formatTimeInput;
window.applyBulkTimesToGrid = applyBulkTimesToGrid;
window.submitBatchAttendance = submitBatchAttendance;
window.applyAttendanceFilters = applyAttendanceFilters;