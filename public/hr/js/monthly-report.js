// public/hr/js/monthly-report.js
import { db } from "../../js/firestore.js";
import { initHRPageSession } from "./hr-log.js";
import {
  collection,
  collectionGroup,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// =========================================================================
// 🚀 1. เริ่มต้นทำงาน ตั้งค่าเดือนเริ่มต้น (รอบปัจจุบัน) และโหลดรายงานทันที
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  const monthInput = document.getElementById("reportMonthSelect");
  if (monthInput && !monthInput.value) {
    const today = new Date();
    // ถ้าระหว่างวันที่ 26 เป็นต้นไป ให้เลื่อนรอบบัญชีเป็นเดือนถัดไปโดยอัตโนมัติ
    let targetYear = today.getFullYear();
    let targetMonth = today.getMonth() + 1;
    if (today.getDate() >= 26) {
      targetMonth += 1;
      if (targetMonth > 12) {
        targetMonth = 1;
        targetYear += 1;
      }
    }
    monthInput.value = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  }

  await loadMonthlyReportData();
});

// =========================================================================
// 📊 2. โหลดข้อมูลพนักงานและประวัติลงเวลารอบวันที่ 26 เดือนก่อน - 25 เดือนปัจจุบัน
// =========================================================================
async function loadMonthlyReportData() {
  const targetMonth = document.getElementById("reportMonthSelect").value;
  if (!targetMonth) return;

  toggleLoader(true);

  try {
    const res = await getMonthlyAttendanceReport(targetMonth);
    if (res.error) {
      console.warn("Warning:", res.error);
    }

    populateShopFilterDropdown(res.staff);
    buildMonthlyTableMatrix(targetMonth, res.staff, res.logs);
    filterMonthlyReportRows();
  } catch (err) {
    console.error("Error loadMonthlyReportData:", err);
    alert("ดึงรายงานล้มเหลว: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

async function getMonthlyAttendanceReport(yearMonth) {
  if (!yearMonth) return { staff: [], logs: {} };

  // คำนวณรอบบัญชี: วันที่ 26 เดือนก่อน ถึง วันที่ 25 เดือนปัจจุบัน
  const parts = yearMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const startDate = `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`;
  const nextMonthDate = `${year}-${String(month).padStart(2, "0")}-26`; // น้อยกว่าวันที่ 26 = สิ้นสุดวันที่ 25

  // 1. ดึงข้อมูลรายชื่อพนักงานที่ยังทำงานอยู่ทั้งหมดจาก /hr
  const empSnap = await getDocs(collection(db, "hr"));
  const staffList = [];
  const activeEmpIds = new Set();

  empSnap.forEach(docSnap => {
    const emp = docSnap.data() || {};
    const status = String(emp.status || emp.employment?.status || "").trim();

    if (status !== "out" && status !== "ออก") {
      const empId = String(emp.employee_id || emp.id || docSnap.id).trim().padStart(4, "0");
      const empName = emp.name || emp.personal_info?.name || emp.profile?.name || "-";
      const empNick = emp.nickname || emp.nick || emp.personal_info?.nickname || emp.profile?.nickname || "-";
      const empPos = emp.position || emp.employment?.position || emp.work?.position || "-";
      const empShop = String(emp.shop || emp.workplace || emp.employment?.shop || emp.employment?.workplace || "ไม่ระบุสาขา").trim();

      staffList.push({
        employee_id: empId,
        name: empName,
        nick: empNick,
        position: empPos,
        shop: empShop
      });
      activeEmpIds.add(empId);
    }
  });

  // เรียงลำดับตามร้านค้า และตามด้วย ID พนักงาน
  staffList.sort((a, b) => {
    const shopCompare = a.shop.localeCompare(b.shop, "th");
    if (shopCompare !== 0) return shopCompare;
    return a.employee_id.localeCompare(b.employee_id);
  });

  if (staffList.length === 0) {
    return { staff: [], logs: {} };
  }

  // 2. ดึงประวัติเวลาทำงานช่วงวันที่ 26 เดือนก่อน ถึง 25 เดือนปัจจุบัน
  const attendanceLogsMap = {};

  try {
    const logsQuery = query(
      collectionGroup(db, "attendance_logs"),
      where("date", ">=", startDate),
      where("date", "<", nextMonthDate)
    );
    const logsSnap = await getDocs(logsQuery);

    logsSnap.forEach(logDoc => {
      const parentEmpDoc = logDoc.ref.parent.parent;
      const empId = parentEmpDoc ? String(parentEmpDoc.id).trim().padStart(4, "0") : "";
      const logData = logDoc.data() || {};
      const logDate = logData.date || logDoc.id;

      if (empId && logDate && activeEmpIds.has(empId)) {
        if (!attendanceLogsMap[empId]) attendanceLogsMap[empId] = {};
        attendanceLogsMap[empId][logDate] = {
          status: logData.status || "",
          ot_hours: Number(logData.ot_hours) || 0
        };
      }
    });
  } catch (cgErr) {
    // Fallback: กรณี Firestore ยังไม่ได้สร้าง Composite Index ให้ดึง subcollection ของแต่ละคนแบบขนาน
    console.warn("Fallback to per-employee attendance_logs fetch:", cgErr.message);

    await Promise.all(
      staffList.map(async emp => {
        try {
          const empLogsQuery = query(
            collection(db, "hr", emp.employee_id, "attendance_logs"),
            where("date", ">=", startDate),
            where("date", "<", nextMonthDate)
          );
          const empLogsSnap = await getDocs(empLogsQuery);

          empLogsSnap.forEach(logDoc => {
            const logData = logDoc.data() || {};
            const logDate = logData.date || logDoc.id;
            if (logDate) {
              if (!attendanceLogsMap[emp.employee_id]) attendanceLogsMap[emp.employee_id] = {};
              attendanceLogsMap[emp.employee_id][logDate] = {
                status: logData.status || "",
                ot_hours: Number(logData.ot_hours) || 0
              };
            }
          });
        } catch (e) {
          console.error(`Error fetching logs for ${emp.employee_id}:`, e);
        }
      })
    );
  }

  return { staff: staffList, logs: attendanceLogsMap };
}

// =========================================================================
// 🧱 3. สร้างหัวตารางปฏิทิน 26 - 25 และคำนวณยอดสรุปรายบุคคล
// =========================================================================
function buildMonthlyTableMatrix(yearMonth, staffList, logsMap) {
  const tableBody = document.getElementById("monthlyTableBody");
  if (!tableBody) return;

  const parts = yearMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const prevMonth = month === 1 ? 12 : month - 1;

  const dateList = [];
  let curDate = new Date(year, month - 2, 26);
  const endDate = new Date(year, month - 1, 25);

  while (curDate <= endDate) {
    const y = curDate.getFullYear();
    const m = String(curDate.getMonth() + 1).padStart(2, "0");
    const d = String(curDate.getDate()).padStart(2, "0");
    dateList.push({
      dateStr: `${y}-${m}-${d}`,
      dayNum: curDate.getDate()
    });
    curDate.setDate(curDate.getDate() + 1);
  }
  const cycleDaysCount = dateList.length;

  const table = tableBody.closest("table");
  const thead = table ? table.querySelector("thead") : null;

  if (thead) {
    const dayHeadersHtml = dateList
      .map(
        item =>
          `<th style="position: sticky; top: 31px; background-color: #e9ecef; color: #212529; z-index: 9; font-size: 0.75rem;" width="42px">${item.dayNum}</th>`
      )
      .join("");

    thead.innerHTML = `
      <tr>
        <th style="position: sticky; top: 0; left: 0; background-color: #212529; color: white; z-index: 15; width: 60px;" rowspan="2">ID</th>
        <th style="position: sticky; top: 0; left: 60px; background-color: #212529; color: white; z-index: 15; width: 140px;" class="text-start" rowspan="2">ชื่อพนักงาน</th>
        <th style="position: sticky; top: 0; background-color: #212529; color: white; z-index: 10; width: 75px;" rowspan="2">ชื่อเล่น</th>
        <th style="position: sticky; top: 0; background-color: #212529; color: white; z-index: 10; width: 120px;" class="text-start" rowspan="2">ตำแหน่ง</th>
        <th style="position: sticky; top: 0; background-color: #212529; color: white; z-index: 10; width: 110px;" rowspan="2">ร้าน</th>
        <th style="position: sticky; top: 0; background-color: #495057; color: white; z-index: 10;" class="text-center" colspan="${cycleDaysCount}">สถานะการเข้างานรายวัน (วันที่ 26/${prevMonth} - 25/${month})</th>
        <th style="position: sticky; top: 0; background-color: #6c757d; color: white; z-index: 10;" class="text-center" colspan="12">รวมจำนวน (วัน / ชม. OT)</th>
      </tr>
      <tr>
        ${dayHeadersHtml}
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #198754; z-index: 9; font-weight: bold;" width="45px" class="x-small">Full</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #6f42c1; z-index: 9; font-weight: bold;" width="50px" class="x-small">Half</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #dc3545; z-index: 9;" width="45px" class="x-small">Sick</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #6c757d; z-index: 9;" width="45px" class="x-small">Off</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #dc3545; z-index: 9; font-weight: bold;" width="45px" class="x-small">Abs</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #ffc107; z-index: 9; font-weight: bold;" width="45px" class="x-small">Late</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #0d6efd; z-index: 9;" width="45px" class="x-small">Lev</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #0dcaf0; z-index: 9; font-weight: bold;" width="45px" class="x-small">Ex</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #198754; z-index: 9; font-weight: bold;" width="55px" class="x-small">F/PH</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #6f42c1; z-index: 9; font-weight: bold;" width="55px" class="x-small">H/PH</th>
        <th style="position: sticky; top: 31px; background-color: #f8f9fa; color: #721c24; z-index: 9; font-weight: bold;" width="55px" class="x-small">W.Pay</th>
        <th style="position: sticky; top: 31px; background-color: #ffc107; color: #212529; z-index: 9;" width="50px" class="x-small">OT(ชม.)</th>
      </tr>
    `;
  }

  if (!staffList || staffList.length === 0) {
    const totalCols = cycleDaysCount + 17;
    tableBody.innerHTML = `<tr><td colspan="${totalCols}" class="text-center py-5 text-muted">ไม่พบข้อมูลพนักงานในระบบคลาวด์</td></tr>`;
    return;
  }

  let bodyHtml = "";

  staffList.forEach(emp => {
    const empId = emp.employee_id;
    const counts = {
      Full: 0,
      Half: 0,
      Sick: 0,
      Off: 0,
      Absent: 0,
      Late: 0,
      Leave: 0,
      "Extra Day": 0,
      "Full/PH": 0,
      "Half/PH": 0,
      "Without Pay": 0,
      OT: 0
    };
    let daysDataHtml = "";

    dateList.forEach(item => {
      const dateStr = item.dateStr;
      const empLog = logsMap[empId] && logsMap[empId][dateStr] ? logsMap[empId][dateStr] : null;

      let symbol = "-";
      let cellStyle = "";

      if (empLog) {
        const status = empLog.status || "";
        counts.OT += Number(empLog.ot_hours) || 0;

        if (status.startsWith("Late")) {
          counts.Late++;
          if (status.includes("Half")) {
            counts.Half++;
            symbol = "Late/H";
            cellStyle = "color: #b27b00; background: #fff9e6; font-weight: bold; font-size: 0.65rem;";
          } else {
            counts.Full++;
            symbol = "Late";
            cellStyle = "color: #b27b00; background: #fff9e6; font-weight: bold;";
          }
        } else {
          if (counts[status] !== undefined) {
            counts[status]++;
          }
          if (status === "Full") {
            symbol = "Full";
            cellStyle = "color: #198754; font-weight: bold;";
          } else if (status === "Half") {
            symbol = "Half";
            cellStyle = "color: #6f42c1; font-weight: bold;";
          } else if (status === "Sick") {
            symbol = "S";
            cellStyle = "color: #dc3545; background: #fdf2f2; font-weight: bold;";
          } else if (status === "Off" || status === "Day Off") {
            if (status === "Day Off") counts.Off++;
            symbol = "Off";
            cellStyle = "color: #6c757d; background: #f8f9fa;";
          } else if (status === "Absent") {
            symbol = "Abs";
            cellStyle = "color: #dc3545; background: #ffe6e6; font-weight: bold;";
          } else if (status === "Leave") {
            symbol = "Lev";
            cellStyle = "color: #0d6efd; background: #e6f0ff;";
          } else if (status === "Extra Day") {
            symbol = "Ex";
            cellStyle = "color: #0dcaf0; background: #e6fcfd; font-weight: bold;";
          } else if (status === "Full/PH") {
            symbol = "F/PH";
            cellStyle = "color: #198754; background: #e6f9ed; font-weight: bold;";
          } else if (status === "Half/PH") {
            symbol = "H/PH";
            cellStyle = "color: #6f42c1; background: #fbf9ff; font-weight: bold;";
          } else if (status === "Without Pay") {
            symbol = "W.P";
            cellStyle = "color: #721c24; background: #f8d7da; font-weight: bold;";
          }
        }
      }

      daysDataHtml += `<td style="font-size: 0.75rem; ${cellStyle}">${symbol}</td>`;
    });

    bodyHtml += `
      <tr class="monthly-report-row" data-shop="${escapeHtml(emp.shop)}">
        <td style="position: sticky; left: 0; background: #f8f9fa; z-index: 2; font-weight: bold;" class="text-secondary border-end">${escapeHtml(empId)}</td>
        <td style="position: sticky; left: 60px; background: #f8f9fa; z-index: 2; font-weight: bold;" class="text-start border-end text-truncate">${escapeHtml(emp.name)}</td>
        <td class="text-muted text-truncate">${escapeHtml(emp.nick)}</td>
        <td class="text-start text-muted text-truncate">${escapeHtml(emp.position)}</td>
        <td class="text-secondary fw-bold text-truncate" style="background: #fff9e6;">${escapeHtml(emp.shop)}</td>

        ${daysDataHtml}

        <td class="fw-bold text-success" style="background: #e6f9ed;">${counts.Full}</td>
        <td class="fw-bold" style="color: #6f42c1; background: #fbf9ff;">${counts.Half}</td>
        <td class="text-danger fw-bold">${counts.Sick}</td>
        <td class="text-muted">${counts.Off}</td>
        <td class="text-danger fw-bold" style="background: #fdf2f2;">${counts.Absent}</td>
        <td class="text-warning fw-bold">${counts.Late}</td>
        <td class="text-primary fw-bold">${counts.Leave}</td>
        <td class="text-info fw-bold">${counts["Extra Day"]}</td>
        <td class="fw-bold text-success" style="background: #e6f9ed;">${counts["Full/PH"]}</td>
        <td class="fw-bold" style="color: #6f42c1; background: #fbf9ff;">${counts["Half/PH"]}</td>
        <td class="fw-bold" style="color: #721c24; background: #f8d7da;">${counts["Without Pay"]}</td>
        <td class="fw-bold text-dark bg-light border-end">${counts.OT}</td>
      </tr>
    `;
  });

  tableBody.innerHTML = bodyHtml;
}

// =========================================================================
// 🛠️ Helper Functions (ตัวกรองสาขา & UI)
// =========================================================================
function populateShopFilterDropdown(staffList) {
  const selectEl = document.getElementById("reportShopFilter");
  if (!selectEl) return;

  const currentVal = selectEl.value || "ALL";
  const uniqueShops = [...new Set(staffList.map(s => s.shop).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "th")
  );

  selectEl.innerHTML =
    `<option value="ALL">-- แสดงทุกสาขา/ร้าน (${staffList.length} คน) --</option>` +
    uniqueShops.map(shop => `<option value="${escapeHtml(shop)}">${escapeHtml(shop)}</option>`).join("");

  if (currentVal && uniqueShops.includes(currentVal)) {
    selectEl.value = currentVal;
  }
}

function filterMonthlyReportRows() {
  const selectedShop = document.getElementById("reportShopFilter")?.value || "ALL";
  const rows = document.querySelectorAll("#monthlyTableBody tr.monthly-report-row");

  rows.forEach(row => {
    const rowShop = row.getAttribute("data-shop") || "";
    row.style.display = selectedShop === "ALL" || rowShop === selectedShop ? "" : "none";
  });
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
window.loadMonthlyReportData = loadMonthlyReportData;
window.filterMonthlyReportRows = filterMonthlyReportRows;