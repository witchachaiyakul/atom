// public/hr/js/payroll.js
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

let isInitialLoading = false;
let currentActiveCalendarEmpId = null;
let currentActiveCalendarCache = {};
let calendarCacheByEmp = {};

// =========================================================================
// 💰 ระบบสรุปและตั้งเบิกเงินเดือนพนักงาน (Payroll โมดูล)
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  const monthInput = document.getElementById("payrollMonthSelect");
  if (monthInput && !monthInput.value) {
    const now = new Date();
    const currentMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    monthInput.value = currentMonth;
  }

  await loadPayrollGridData();
});

async function loadPayrollGridData() {
  const targetMonth = document.getElementById("payrollMonthSelect").value;
  if (!targetMonth) return;

  toggleLoader(true);
  closeActiveCalendar();
  calendarCacheByEmp = {};
  currentActiveCalendarCache = {};

  try {
    const res = await getPayrollReport(targetMonth);
    if (res.error) {
      console.warn("Warning:", res.error);
    }

    const quotaInput = document.getElementById("payrollDayOffQuota");
    if (quotaInput) {
      const dayOffVal = res.default_day_off !== undefined ? res.default_day_off : 4;
      quotaInput.value = dayOffVal;
      quotaInput.setAttribute("data-old", dayOffVal);
    }

    buildPayrollTableMatrix(res.staff);
  } catch (err) {
    console.error("Error loadPayrollGridData:", err.message);
    alert("โหลดข้อมูลเงินเดือนล้มเหลว: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

async function getPayrollReport(yearMonth) {
  if (!yearMonth) return { staff: [], default_day_off: 4 };

  // 1. ดึงสิทธิ Day Off ตั้งต้นจาก config/payroll_settings
  let defaultDayOff = 4;
  try {
    const configSnap = await getDoc(doc(db, "config", "payroll_settings"));
    if (configSnap.exists()) {
      const cfg = configSnap.data() || {};
      if (cfg.day_off_quota !== undefined) {
        defaultDayOff = Number(cfg.day_off_quota);
      }
    }
  } catch (cfgErr) {
    console.warn("ไม่พบเอกสาร config/payroll_settings ใช้ค่า Default 4 วัน:", cfgErr.message);
  }

  // 2. ดึงข้อมูลรายชื่อพนักงานที่ยังทำงานอยู่ทั้งหมด
  const empSnap = await getDocs(collection(db, "hr"));
  const staffList = [];
  const activeEmpIds = new Set();

  empSnap.forEach(docSnap => {
    const emp = docSnap.data() || {};
    const status = String(emp.status || emp.employment?.status || "").trim();

    if (status !== "ออก" && status !== "out") {
      const empId = String(emp.employee_id || emp.id || docSnap.id).trim().padStart(4, "0");
      const empName = emp.name || emp.profile?.name || emp.personal_info?.name || "-";
      const empNick = emp.nickname || emp.nick || emp.profile?.nickname || emp.profile?.nick || "-";
      const empPosition = emp.position || emp.employment?.position || "-";
      const empShop = String(emp.shop || emp.workplace || emp.employment?.shop || emp.employment?.workplace || "ไม่ระบุสาขา").trim();
      const baseSalary = Number(emp.salary) || Number(emp.employment?.salary) || 0;
      const empWelfare = emp.welfare || {
        social_security: false,
        Employee_Contribution: 0,
        Employer_Contribution: 0,
        housing: { type: "", subsidy: 0, accommodation_cost: 0 }
      };
      const housingData = emp.welfare?.housing || { type: "", subsidy: 0, accommodation_cost: 0 };

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

      staffList.push({
        employee_id: empId,
        name: empName,
        nick: empNick,
        position: empPosition,
        shop: empShop,
        base_salary: baseSalary,
        counts: counts,
        welfare: empWelfare,
        housing_info: housingData
      });
      activeEmpIds.add(empId);
    }
  });

  if (staffList.length === 0) {
    return { staff: [], default_day_off: defaultDayOff };
  }

  // 3. คำนวณช่วงวันที่รอบตั้งเบิกเงินเดือน (26 เดือนก่อน - 25 เดือนปัจจุบัน)
  const parts = yearMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const startDate = `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`;
  const nextMonthDate = `${year}-${String(month).padStart(2, "0")}-26`;

  // 4. ดึงประวัติเวลาเข้างานจริงรายบุคคล
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
    console.warn("Fallback to per-employee attendance_logs fetch:", cgErr.message);
    await Promise.all(
      staffList.map(async emp => {
        try {
          const empLogsSnap = await getDocs(
            query(
              collection(db, "hr", emp.employee_id, "attendance_logs"),
              where("date", ">=", startDate),
              where("date", "<", nextMonthDate)
            )
          );
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

  // ประมวลผลสถิติวันทำงาน
  staffList.forEach(staffTarget => {
    const empLogs = attendanceLogsMap[staffTarget.employee_id];
    if (empLogs) {
      Object.keys(empLogs).forEach(logDate => {
        const logData = empLogs[logDate];
        const statusLog = String(logData.status || "").trim();
        if (statusLog.startsWith("Late")) {
          staffTarget.counts.Late++;
          if (statusLog.includes("Half")) {
            staffTarget.counts.Half++;
          } else {
            staffTarget.counts.Full++;
          }
        } else {
          const effectiveStatus = statusLog === "Day Off" ? "Off" : statusLog;
          if (staffTarget.counts[effectiveStatus] !== undefined) {
            staffTarget.counts[effectiveStatus]++;
          }
        }
        staffTarget.counts.OT += Number(logData.ot_hours) || 0;
      });
    }
  });

  // 5. ดึงประวัติตั้งเบิกเงินเดือนเก่าของรอบเดือนนี้แบบขนาน
  await Promise.all(
    staffList.map(async staffTarget => {
      try {
        const payrollSnap = await getDoc(doc(db, "hr", staffTarget.employee_id, "payroll", yearMonth));
        if (payrollSnap.exists()) {
          staffTarget.existing_payroll = payrollSnap.data();
        }
      } catch (pErr) {
        console.warn(`Error fetching existing payroll for ${staffTarget.employee_id}:`, pErr.message);
      }
    })
  );

  // 6. จัดเรียงลำดับร้านและรหัสพนักงาน
  staffList.sort((a, b) => {
    const shopCompare = a.shop.localeCompare(b.shop, "th");
    if (shopCompare !== 0) return shopCompare;
    return a.employee_id.localeCompare(b.employee_id);
  });

  return { staff: staffList, default_day_off: defaultDayOff };
}

function formatInputWithCommas(inputEl) {
  let cursorPosition = inputEl.selectionStart;
  let originalLength = inputEl.value.length;

  let cleanValue = inputEl.value.replace(/[^0-9.]/g, "");
  let parts = cleanValue.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  if (parts.length > 1) {
    inputEl.value = parts[0] + "." + parts[1].substring(0, 2);
  } else {
    inputEl.value = parts[0];
  }

  let newLength = inputEl.value.length;
  cursorPosition = cursorPosition + (newLength - originalLength);
  if (typeof inputEl.setSelectionRange === "function" && cursorPosition >= 0) {
    inputEl.setSelectionRange(cursorPosition, cursorPosition);
  }

  calculatePayrollRow(inputEl);
}

function onBaseSalaryInputChange(inputEl) {
  let cursorPosition = inputEl.selectionStart;
  let originalLength = inputEl.value.length;

  let cleanValue = inputEl.value.replace(/[^0-9.]/g, "");
  let parts = cleanValue.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  if (parts.length > 1) {
    inputEl.value = parts[0] + "." + parts[1].substring(0, 2);
  } else {
    inputEl.value = parts[0];
  }

  let newLength = inputEl.value.length;
  cursorPosition = cursorPosition + (newLength - originalLength);
  if (typeof inputEl.setSelectionRange === "function" && cursorPosition >= 0) {
    inputEl.setSelectionRange(cursorPosition, cursorPosition);
  }

  calculatePayrollRow(inputEl);
}

function buildPayrollTableMatrix(staffList) {
  isInitialLoading = true;
  const tableBody = document.getElementById("payrollTableBody");
  const saveBtn = document.getElementById("btnSavePayroll");
  const printBtn = document.getElementById("btnPrintPayroll");
  const slipsBtn = document.getElementById("btnPrintSlips");
  const shopSelect = document.getElementById("payrollShopSelect");

  if (!staffList || staffList.length === 0) {
    tableBody.innerHTML =
      '<tr><td colspan="34" class="text-center py-5 text-muted">ไม่พบข้อมูลพนักงานประจำเดือนนี้ในระบบคลาวด์</td></tr>';
    saveBtn?.classList.add("d-none");
    printBtn?.classList.add("d-none");
    slipsBtn?.classList.add("d-none");
    isInitialLoading = false;
    return;
  }

  if (shopSelect) {
    const prevShop = shopSelect.value;
    const uniqueShops = [...new Set(staffList.map(emp => emp.shop).filter(Boolean))];
    let shopOptions = '<option value="">-- แสดงทุกสาขา/ร้าน (ทั้งหมด) --</option>';
    uniqueShops.forEach(shop => {
      shopOptions += `<option value="${escapeHtml(shop)}">${escapeHtml(shop)}</option>`;
    });
    shopSelect.innerHTML = shopOptions;
    if (prevShop && uniqueShops.includes(prevShop)) {
      shopSelect.value = prevShop;
    }
  }

  const targetMonth = document.getElementById("payrollMonthSelect").value;
  const parts = targetMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  const startDate = new Date(year, month - 2, 26);
  const endDate = new Date(year, month - 1, 25);
  const diffTime = Math.abs(endDate - startDate);
  const daysInMonth = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;

  const quotaDayOff = parseFloat(document.getElementById("payrollDayOffQuota").value) || 0;

  let bodyHtml = "";
  saveBtn?.classList.remove("d-none");
  printBtn?.classList.remove("d-none");
  slipsBtn?.classList.remove("d-none");

  staffList.forEach((emp, idx) => {
    const empId = emp.employee_id;
    const c = emp.counts || {};
    const baseSalary = Number(emp.base_salary || 0);

    const countWork = Number(c["Full"] || 0);
    const countHalf = Number(c["Half"] || 0);
    const countSick = Number(c["Sick"] || 0);
    const countOff = Number(c["Off"] || 0);
    const countAbsent = Number(c["Absent"] || 0);
    const countLate = Number(c["Late"] || 0);
    const countLeave = Number(c["Leave"] || 0);
    const countExtraDay = Number(c["Extra Day"] || 0);
    const countFullPH = Number(c["Full/PH"] || 0);
    const countHalfPH = Number(c["Half/PH"] || 0);
    const countOt = Number(c["OT"] || 0);
    const countWithoutPay = Number(c["Without Pay"] || 0);

    // คำนวณจำนวนวันที่คิดค่าจ้างตามเงื่อนไข (Full/PH = Full*2)
    const effectiveFullWork = countWork + countFullPH * 2;

    const hasSS = emp.welfare && (emp.welfare.social_security === true || emp.welfare.social_security === "true");
    const hConfig = emp.welfare && emp.welfare.housing ? emp.welfare.housing : {};
    const hTypeLower = String(hConfig.type || "").toLowerCase().trim();

    const hasSaved = emp.existing_payroll ? true : false;
    const oldP = emp.existing_payroll || {};
    const oldEarn = oldP.earnings || {};
    const oldDed = oldP.deductions || {};

    const savedType =
      oldP.calculation_type || (countWork === 0 && (countHalf > 0 || countHalfPH > 0) ? "Monthly" : "Daily");
    const optDailySelected = savedType === "Daily" ? "selected" : "";
    const optMonthlySelected = savedType === "Monthly" ? "selected" : "";

    let autoEarnHalfDay = 0;
    let autoEarnFull = 0;
    let autoEarnExtraDay = 0;
    let autoDedAbsent = 0;

    if (hasSaved) {
      autoEarnHalfDay = Number(oldEarn.other_allowance ?? 0);
      autoEarnFull = Number(oldEarn.salary ?? 0);
      autoEarnExtraDay = Number(oldEarn.extra_day_pay ?? 0);
      autoDedAbsent = Number(oldDed.absent_deduction ?? 0);

      // ดักแก้ค่า Full เพี้ยนกรณีบันทึกเก่า โดยคิดตาม effectiveFullWork (รวม Full/PH * 2)
      if (autoEarnFull === baseSalary) {
        if (savedType === "Monthly") {
          autoEarnFull = Math.round((effectiveFullWork * (baseSalary / 2)) / 30);
        } else {
          autoEarnFull = 0;
        }
      }
    } else {
      if (savedType === "Monthly") {
        autoEarnHalfDay = Math.round(baseSalary / 2);
        autoEarnFull = Math.round((effectiveFullWork * (baseSalary / 2)) / 30);
        autoEarnExtraDay = Math.round((countExtraDay * (baseSalary / 2)) / 30);
        autoDedAbsent = Math.round(countAbsent * (baseSalary / 2 / 30));
      } else {
        autoEarnHalfDay = baseSalary;
        autoEarnFull = 0;
        autoEarnExtraDay = Math.round((baseSalary / 30) * countExtraDay);
        autoDedAbsent = Math.round(countAbsent * (baseSalary / 30));
      }
    }

    const autoEarnOt = hasSaved ? Number(oldEarn.ot_pay ?? 0) : countOt * 50;
    const autoEarnFood = hasSaved
      ? Number(oldEarn.food_allowance ?? 0)
      : (countWork + countHalf + countExtraDay + countFullPH + countHalfPH) * 60;
    const autoEarnHousing = hasSaved
      ? Number(oldEarn.housing_allowance ?? 0)
      : hTypeLower === "outside"
      ? Number(hConfig.subsidy || 0)
      : 0;

    const autoDedAdvance = hasSaved ? Number(oldDed.advance ?? 0) : 0;
    const autoDedRoom = hasSaved
      ? Number(oldDed.room_rent ?? 0)
      : hTypeLower === "company"
      ? Number(hConfig.accommodation_cost || 0)
      : 0;
    const socialSecurityDeduction = hasSaved
      ? Number(oldDed.social_security ?? 0)
      : hasSS
      ? Number(emp.welfare.Employee_Contribution || 0)
      : 0;
    const autoDedOther = hasSaved ? Number(oldDed.other_deduction ?? 0) : 0;

    let autoDedExcessDayOff = 0;
    if (hasSaved) {
      autoDedExcessDayOff = Number(oldDed.excess_day_off ?? 0);
    } else {
      if (countOff > quotaDayOff) {
        const effectiveSalary = savedType === "Monthly" ? baseSalary / 2 : baseSalary;
        autoDedExcessDayOff = Math.round((countOff - quotaDayOff) * (effectiveSalary / daysInMonth));
      }
    }

    const initialTotalEarn =
      autoEarnOt + autoEarnExtraDay + autoEarnFood + autoEarnFull + autoEarnHalfDay + autoEarnHousing;
    const initialTotalDed =
      autoDedExcessDayOff + socialSecurityDeduction + autoDedRoom + autoDedAbsent + autoDedAdvance + autoDedOther;
    const initialNetPay = initialTotalEarn - initialTotalDed;

    bodyHtml += `
      <tr class="payroll-row" 
          id="payroll-row-${escapeHtml(empId)}"
          data-emp-id="${escapeHtml(empId)}" 
          data-shop="${escapeHtml(emp.shop)}" 
          data-housing-subsidy="${hConfig.subsidy || 0}" 
          data-room-rent="${hConfig.accommodation_cost || 0}" 
          data-social-deduction="${emp.welfare ? emp.welfare.Employee_Contribution || 0 : 0}" 
          data-without-pay="${countWithoutPay}" 
          data-count-full-ph="${countFullPH}"
          data-count-half-ph="${countHalfPH}"
          data-base-salary="${baseSalary}">
        <td style="position: sticky; left: 0; background: #f8f9fa; z-index: 2; font-weight: bold;" class="text-secondary border-end">${idx + 1}</td>
        <td style="position: sticky; left: 60px; background: #f8f9fa; z-index: 2; font-weight: bold;" class="text-start border-end text-truncate">${escapeHtml(emp.name)}</td>
        <td class="text-muted text-truncate">${escapeHtml(emp.nick)}</td>
        <td class="text-start text-muted text-truncate">${escapeHtml(emp.position)}</td>
        <td class="text-secondary fw-bold text-truncate" style="background:#fff9e6;">${escapeHtml(emp.shop)}</td>
        
        <td class="fw-bold text-success pr-work summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countWork}</td>
        <td class="fw-bold pr-half summary-number-trigger" style="cursor: pointer; color: #6f42c1;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countHalf}</td>
        <td class="text-danger pr-sick summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countSick}</td>
        <td class="text-muted pr-off summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countOff}</td>
        <td class="text-danger pr-absent summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countAbsent}</td>
        <td class="text-warning pr-late summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countLate}</td>
        <td class="text-primary pr-leave summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countLeave}</td>
        <td class="text-info pr-extra-day summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countExtraDay}</td>
        
        <td class="fw-bold text-success pr-full-ph summary-number-trigger" style="cursor: pointer; background: #e6f9ed;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countFullPH}</td>
        <td class="fw-bold pr-half-ph summary-number-trigger" style="cursor: pointer; color: #6f42c1; background: #fbf9ff;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countHalfPH}</td>
        
        <td class="fw-bold text-dark bg-light pr-ot summary-number-trigger" style="cursor: pointer;" onclick="toggleEmployeeCalendar('${escapeHtml(empId)}', '${escapeHtml(emp.name)}')">${countOt}</td>
        
        <td><input type="text" class="form-control form-control-sm text-end p-salary fw-bold border-primary" value="${baseSalary.toLocaleString()}" oninput="onBaseSalaryInputChange(this)"></td>
        
        <td>
          <select class="form-select form-select-sm p-salary-type fw-bold text-center border-primary" onchange="calculatePayrollRow(this)">
            <option value="Daily" ${optDailySelected}>แบบวัน</option>
            <option value="Monthly" ${optMonthlySelected}>แบบเดือน</option>
          </select>
        </td>

        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary p-0 px-1" onclick="syncHousingRow(this)" title="ดึงค่าที่พักจากโปรไฟล์">
            🔄
          </button>
        </td>

        <td><input type="text" class="form-control form-control-sm text-end p-earn-other" value="${autoEarnHalfDay.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-earn-food" value="${autoEarnFood.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-earn-housing" value="${autoEarnHousing.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-earn-full" value="${autoEarnFull.toLocaleString()}" oninput="calculatePayrollRow(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-earn-ot bg-light" value="${autoEarnOt.toLocaleString()}" readonly></td>
        <td><input type="text" class="form-control form-control-sm text-end p-earn-extra" value="${autoEarnExtraDay.toLocaleString()}" oninput="calculatePayrollRow(this)"></td>
        
        <td><input type="text" class="form-control form-control-sm text-end p-ded-advance fw-bold text-danger border-danger-subtle" value="${autoDedAdvance.toLocaleString()}" onfocus="this.select()" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-ded-room" value="${autoDedRoom.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-ded-social" value="${socialSecurityDeduction.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-ded-other" value="${autoDedOther.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-ded-absent" value="${autoDedAbsent.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        <td><input type="text" class="form-control form-control-sm text-end p-ded-excess-off" value="${autoDedExcessDayOff.toLocaleString()}" oninput="formatInputWithCommas(this)"></td>
        
        <td class="fw-bold text-success text-end p-total-earn" style="background:#e6f9ed;">${initialTotalEarn.toLocaleString()}</td>
        <td class="fw-bold text-danger text-end p-total-ded" style="background:#fdf2f2;">${initialTotalDed.toLocaleString()}</td>
        <td class="fw-bold text-white bg-primary text-end p-net-pay">${initialNetPay.toLocaleString()}</td>
      </tr>

      <tr id="calendar-dropdown-${escapeHtml(empId)}" class="calendar-dropdown-row d-none" data-emp-id="${escapeHtml(empId)}">
        <td colspan="5" class="bg-light border-0"></td>
        <td colspan="11" class="p-2 bg-light border-start border-end border-warning align-top" style="min-width: 415px; max-width: 450px;">
          <div class="card shadow border-warning">
            <div class="card-header bg-dark text-white d-flex justify-content-between align-items-center py-1 px-2">
              <span class="fw-bold" style="font-size: 0.75rem;"><i class="bi bi-calendar3"></i> ประวัติงานรายวัน (${escapeHtml(emp.name)})</span>
              <button type="button" class="btn btn-sm btn-outline-light py-0 px-1" style="font-size: 0.65rem; line-height: 1;" onclick="closeActiveCalendar()">✕ ซ่อน</button>
            </div>
            <div class="card-body p-1" style="background-color: #fffdf7;">
              <div class="payroll-calendar-grid" style="gap: 3px;">
                <div class="cal-day-header py-1">จ.</div>
                <div class="cal-day-header py-1">อ.</div>
                <div class="cal-day-header py-1">พ.</div>
                <div class="cal-day-header py-1">พฤ.</div>
                <div class="cal-day-header py-1">ศ.</div>
                <div class="cal-day-header text-danger fw-bold py-1">ส.</div>
                <div class="cal-day-header text-danger fw-bold py-1">อา.</div>
              </div>
              <div class="payroll-calendar-body id-grid-target-${escapeHtml(empId)} payroll-calendar-grid mt-1" style="gap: 3px;">
              </div>
            </div>
          </div>
        </td>
        <td colspan="18" class="bg-light border-0"></td>
      </tr>
    `;
  });

  bodyHtml += `
    <tr id="payrollTotalRow" class="table-dark text-end fw-bold" style="border-top: 3px double #212529; font-size: 0.8rem;">
      <td colspan="19" class="py-2 pe-3 text-warning bg-dark align-middle">ยอดรวมสุทธิ (เฉพาะสาขาที่แสดงอยู่):</td>

      <td id="sumEarnOther" class="text-success bg-white text-end align-middle">0</td>
      <td id="sumEarnFood" class="text-success bg-white text-end align-middle">0</td>
      <td id="sumEarnHousing" class="text-success bg-white text-end align-middle">0</td>
      <td id="sumEarnFull" class="text-success bg-white text-end align-middle">0</td>
      <td id="sumEarnOt" class="text-success bg-white text-end align-middle">0</td>
      <td id="sumEarnExtra" class="text-success bg-white text-end align-middle">0</td>

      <td id="sumDedAdvance" class="text-danger bg-white text-end align-middle">0</td>
      <td id="sumDedRoom" class="text-danger bg-white text-end align-middle">0</td>
      <td id="sumDedSocial" class="text-danger bg-white text-end align-middle">0</td>
      <td id="sumDedOther" class="text-danger bg-white text-end align-middle">0</td>
      <td id="sumDedAbsent" class="text-danger bg-white text-end align-middle">0</td>
      <td id="sumDedExcessOff" class="text-danger bg-white text-end align-middle">0</td>

      <td id="grandTotalEarn" class="text-success bg-white text-end align-middle fw-bold">0</td>
      <td id="grandTotalDed" class="text-danger bg-white text-end align-middle fw-bold">0</td>
      <td id="grandNetPay" class="text-white bg-primary text-end align-middle fw-bold">0</td>
    </tr>
  `;

  tableBody.innerHTML = bodyHtml;
  document.querySelectorAll(".payroll-row").forEach(row => {
    const typeSelect = row.querySelector(".p-salary-type");
    if (typeSelect) {
      calculatePayrollRow(typeSelect);
    }
  });
  isInitialLoading = false;
  filterPayrollByShop();
}

function syncHousingRow(btnEl) {
  const row = btnEl.closest("tr");
  const subsidyValue = parseFloat(row.getAttribute("data-housing-subsidy")) || 0;
  const housingInput = row.querySelector(".p-earn-housing");

  if (housingInput) {
    housingInput.value = subsidyValue.toLocaleString();
    calculatePayrollRow(housingInput);
  }
}

function syncAllHousingData() {
  if (
    !confirm(
      "ยืนยัน: ระบบจะดึงข้อมูลพื้นฐาน (ค่าที่พัก, ค่าห้อง, ประกันสังคม) จากโปรไฟล์พนักงานมาใส่เฉพาะช่องที่ยังเป็น 0 ใช่หรือไม่?"
    )
  ) {
    return;
  }

  const rows = document.querySelectorAll(".payroll-row");

  rows.forEach(row => {
    let isRowChanged = false;

    const housingInput = row.querySelector(".p-earn-housing");
    if (housingInput) {
      const currentHousing = parseFloat(housingInput.value.replace(/,/g, "")) || 0;
      if (currentHousing === 0) {
        const subsidyValue = parseFloat(row.getAttribute("data-housing-subsidy")) || 0;
        if (subsidyValue > 0) {
          housingInput.value = subsidyValue.toLocaleString();
          isRowChanged = true;
        }
      }
    }

    const roomInput = row.querySelector(".p-ded-room");
    if (roomInput) {
      const currentRoom = parseFloat(roomInput.value.replace(/,/g, "")) || 0;
      if (currentRoom === 0) {
        const roomRentValue = parseFloat(row.getAttribute("data-room-rent")) || 0;
        if (roomRentValue > 0) {
          roomInput.value = roomRentValue.toLocaleString();
          isRowChanged = true;
        }
      }
    }

    const socialInput = row.querySelector(".p-ded-social");
    if (socialInput) {
      const currentSocial = parseFloat(socialInput.value.replace(/,/g, "")) || 0;
      if (currentSocial === 0) {
        const socialValue = parseFloat(row.getAttribute("data-social-deduction")) || 0;
        if (socialValue > 0) {
          socialInput.value = socialValue.toLocaleString();
          isRowChanged = true;
        }
      }
    }

    if (isRowChanged) {
      calculatePayrollRow(housingInput || roomInput || socialInput);
    }
  });

  alert("Sync ข้อมูลสวัสดิการพื้นฐาน (ค่าที่พัก/ค่าห้อง/ประกันสังคม) ของพนักงานทุกคนเสร็จสิ้นครับ");
}

function calculatePayrollRow(inputEl) {
  const row = inputEl.closest("tr");
  if (!row) return;

  const salaryInputVal = row.querySelector(".p-salary")?.value?.replace(/,/g, "");
  const baseSalary = parseFloat(salaryInputVal) || parseFloat(row.getAttribute("data-base-salary")) || 0;
  row.setAttribute("data-base-salary", baseSalary);

  const salaryType = row.querySelector(".p-salary-type").value;

  const countWork = parseFloat(row.querySelector(".pr-work")?.innerText) || 0;
  const countHalf = parseFloat(row.querySelector(".pr-half")?.innerText) || 0;
  const countAbsent = parseFloat(row.querySelector(".pr-absent")?.innerText) || 0;
  const countOff = parseFloat(row.querySelector(".pr-off")?.innerText) || 0;
  const countExtraDay = parseFloat(row.querySelector(".pr-extra-day")?.innerText) || 0;
  const countOt = parseFloat(row.querySelector(".pr-ot")?.innerText) || 0;

  const countFullPH =
    parseFloat(row.querySelector(".pr-full-ph")?.innerText) ||
    parseFloat(row.getAttribute("data-count-full-ph")) ||
    0;
  const countHalfPH =
    parseFloat(row.querySelector(".pr-half-ph")?.innerText) ||
    parseFloat(row.getAttribute("data-count-half-ph")) ||
    0;

  const effectiveWork = countWork + countFullPH * 2;

  const targetMonth = document.getElementById("payrollMonthSelect").value;
  const parts = targetMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const startDate = new Date(year, month - 2, 26);
  const endDate = new Date(year, month - 1, 25);
  const daysInMonth = Math.round(Math.abs(endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
  const quotaDayOff = parseFloat(document.getElementById("payrollDayOffQuota").value) || 0;

  let autoEarnHalfDay = parseFloat(row.querySelector(".p-earn-other").value.replace(/,/g, "")) || 0;
  let autoEarnFull = parseFloat(row.querySelector(".p-earn-full").value.replace(/,/g, "")) || 0;
  let extraDayAmount = parseFloat(row.querySelector(".p-earn-extra").value.replace(/,/g, "")) || 0;
  let earnFood = parseFloat(row.querySelector(".p-earn-food").value.replace(/,/g, "")) || 0;
  let earnOt = parseFloat(row.querySelector(".p-earn-ot").value.replace(/,/g, "")) || 0;
  let autoDedAbsent = parseFloat(row.querySelector(".p-ded-absent").value.replace(/,/g, "")) || 0;
  let autoDedExcessDayOff = parseFloat(row.querySelector(".p-ded-excess-off").value.replace(/,/g, "")) || 0;

  const isSalaryInput = inputEl.classList.contains("p-salary");
  const isTypeSelect = inputEl.classList.contains("p-salary-type");

  if (!isInitialLoading && (isTypeSelect || isSalaryInput)) {
    if (salaryType === "Monthly") {
      autoEarnHalfDay = Math.round(baseSalary / 2);
      autoEarnFull = Math.round((effectiveWork * (baseSalary / 2)) / 30);
      extraDayAmount = Math.round((countExtraDay * (baseSalary / 2)) / 30);
      autoDedAbsent = Math.round(countAbsent * (baseSalary / 2 / 30));
    } else {
      autoEarnHalfDay = baseSalary;
      autoEarnFull = 0;
      extraDayAmount = Math.round((baseSalary / 30) * countExtraDay);
      autoDedAbsent = Math.round(countAbsent * (baseSalary / 30));
    }

    earnFood = (countWork + countHalf + countExtraDay + countFullPH + countHalfPH) * 60;
    earnOt = countOt * 50;

    if (countOff > quotaDayOff) {
      const effectiveSalary = salaryType === "Monthly" ? baseSalary / 2 : baseSalary;
      autoDedExcessDayOff = Math.round((countOff - quotaDayOff) * (effectiveSalary / daysInMonth));
    } else {
      autoDedExcessDayOff = 0;
    }

    row.querySelector(".p-earn-other").value = autoEarnHalfDay.toLocaleString();
    row.querySelector(".p-earn-full").value = autoEarnFull.toLocaleString();
    row.querySelector(".p-earn-food").value = earnFood.toLocaleString();
    row.querySelector(".p-earn-ot").value = earnOt.toLocaleString();
    row.querySelector(".p-earn-extra").value = extraDayAmount.toLocaleString();
    row.querySelector(".p-ded-absent").value = autoDedAbsent.toLocaleString();
    row.querySelector(".p-ded-excess-off").value = autoDedExcessDayOff.toLocaleString();
  }

  if (!isSalaryInput) {
    row.querySelector(".p-salary").value = baseSalary.toLocaleString();
  }

  const earnHousing = parseFloat(row.querySelector(".p-earn-housing").value.replace(/,/g, "")) || 0;
  const earnExtraDay = parseFloat(row.querySelector(".p-earn-extra").value.replace(/,/g, "")) || 0;

  const dedAdvance = parseFloat(row.querySelector(".p-ded-advance").value.replace(/,/g, "")) || 0;
  const dedRoom = parseFloat(row.querySelector(".p-ded-room").value.replace(/,/g, "")) || 0;
  const dedSocial = parseFloat(row.querySelector(".p-ded-social").value.replace(/,/g, "")) || 0;
  const dedOther = parseFloat(row.querySelector(".p-ded-other").value.replace(/,/g, "")) || 0;

  const totalEarnings = earnOt + earnExtraDay + earnFood + earnHousing + autoEarnFull + autoEarnHalfDay;
  const totalDeductions = dedAdvance + dedRoom + dedSocial + dedOther + autoDedAbsent + autoDedExcessDayOff;
  const netPay = totalEarnings - totalDeductions;

  row.querySelector(".p-total-earn").innerText = totalEarnings.toLocaleString();
  row.querySelector(".p-total-ded").innerText = totalDeductions.toLocaleString();
  row.querySelector(".p-net-pay").innerText = netPay.toLocaleString();

  updateGrandTotal();
}

function updateGrandTotal() {
  const rows = document.querySelectorAll(".payroll-row");

  let sumEarnOther = 0,
    sumEarnFood = 0,
    sumEarnHousing = 0,
    sumEarnFull = 0,
    sumEarnOt = 0,
    sumEarnExtra = 0;
  let sumDedAdvance = 0,
    sumDedRoom = 0,
    sumDedSocial = 0,
    sumDedOther = 0,
    sumDedAbsent = 0,
    sumDedExcessOff = 0;
  let grandEarn = 0,
    grandDed = 0,
    grandNet = 0;

  rows.forEach(row => {
    if (!row.classList.contains("d-none")) {
      sumEarnOther += parseFloat((row.querySelector(".p-earn-other")?.value || "0").replace(/,/g, "")) || 0;
      sumEarnFood += parseFloat((row.querySelector(".p-earn-food")?.value || "0").replace(/,/g, "")) || 0;
      sumEarnHousing += parseFloat((row.querySelector(".p-earn-housing")?.value || "0").replace(/,/g, "")) || 0;
      sumEarnFull += parseFloat((row.querySelector(".p-earn-full")?.value || "0").replace(/,/g, "")) || 0;
      sumEarnOt += parseFloat((row.querySelector(".p-earn-ot")?.value || "0").replace(/,/g, "")) || 0;
      sumEarnExtra += parseFloat((row.querySelector(".p-earn-extra")?.value || "0").replace(/,/g, "")) || 0;

      sumDedAdvance += parseFloat((row.querySelector(".p-ded-advance")?.value || "0").replace(/,/g, "")) || 0;
      sumDedRoom += parseFloat((row.querySelector(".p-ded-room")?.value || "0").replace(/,/g, "")) || 0;
      sumDedSocial += parseFloat((row.querySelector(".p-ded-social")?.value || "0").replace(/,/g, "")) || 0;
      sumDedOther += parseFloat((row.querySelector(".p-ded-other")?.value || "0").replace(/,/g, "")) || 0;
      sumDedAbsent += parseFloat((row.querySelector(".p-ded-absent")?.value || "0").replace(/,/g, "")) || 0;
      sumDedExcessOff += parseFloat((row.querySelector(".p-ded-excess-off")?.value || "0").replace(/,/g, "")) || 0;

      grandEarn += parseFloat((row.querySelector(".p-total-earn")?.innerText || "0").replace(/,/g, "")) || 0;
      grandDed += parseFloat((row.querySelector(".p-total-ded")?.innerText || "0").replace(/,/g, "")) || 0;
      grandNet += parseFloat((row.querySelector(".p-net-pay")?.innerText || "0").replace(/,/g, "")) || 0;
    }
  });

  if (document.getElementById("sumEarnOther")) document.getElementById("sumEarnOther").innerText = sumEarnOther.toLocaleString();
  if (document.getElementById("sumEarnFood")) document.getElementById("sumEarnFood").innerText = sumEarnFood.toLocaleString();
  if (document.getElementById("sumEarnHousing")) document.getElementById("sumEarnHousing").innerText = sumEarnHousing.toLocaleString();
  if (document.getElementById("sumEarnFull")) document.getElementById("sumEarnFull").innerText = sumEarnFull.toLocaleString();
  if (document.getElementById("sumEarnOt")) document.getElementById("sumEarnOt").innerText = sumEarnOt.toLocaleString();
  if (document.getElementById("sumEarnExtra")) document.getElementById("sumEarnExtra").innerText = sumEarnExtra.toLocaleString();

  if (document.getElementById("sumDedAdvance")) document.getElementById("sumDedAdvance").innerText = sumDedAdvance.toLocaleString();
  if (document.getElementById("sumDedRoom")) document.getElementById("sumDedRoom").innerText = sumDedRoom.toLocaleString();
  if (document.getElementById("sumDedSocial")) document.getElementById("sumDedSocial").innerText = sumDedSocial.toLocaleString();
  if (document.getElementById("sumDedOther")) document.getElementById("sumDedOther").innerText = sumDedOther.toLocaleString();
  if (document.getElementById("sumDedAbsent")) document.getElementById("sumDedAbsent").innerText = sumDedAbsent.toLocaleString();
  if (document.getElementById("sumDedExcessOff")) document.getElementById("sumDedExcessOff").innerText = sumDedExcessOff.toLocaleString();

  if (document.getElementById("grandTotalEarn")) document.getElementById("grandTotalEarn").innerText = grandEarn.toLocaleString();
  if (document.getElementById("grandTotalDed")) document.getElementById("grandTotalDed").innerText = grandDed.toLocaleString();
  if (document.getElementById("grandNetPay")) document.getElementById("grandNetPay").innerText = grandNet.toLocaleString();
}

function filterPayrollByShop() {
  const selectedShop = document.getElementById("payrollShopSelect").value;
  const rows = document.querySelectorAll(".payroll-row");
  closeActiveCalendar();

  rows.forEach(row => {
    const rowShop = row.getAttribute("data-shop");
    if (!selectedShop || rowShop === selectedShop) {
      row.classList.remove("d-none");
    } else {
      row.classList.add("d-none");
    }
  });

  updateGrandTotal();
}

async function handleDayOffQuotaChange(inputEl) {
  const newQuota = parseFloat(inputEl.value) || 0;
  const oldQuota = parseFloat(inputEl.getAttribute("data-old")) || 0;
  const targetMonth = document.getElementById("payrollMonthSelect").value;

  if (newQuota === oldQuota) return;

  if (
    !confirm(
      `คุณต้องการเปลี่ยนสิทธิ Day Off ประจำรอบเดือน ${targetMonth} เป็น ${newQuota} วัน\nและสั่งให้ระบบคำนวณยอดหัก "Day Off เกิน" ของพนักงานทุกคนใหม่ใช่หรือไม่?`
    )
  ) {
    inputEl.value = oldQuota;
    return;
  }

  inputEl.setAttribute("data-old", newQuota);
  recalculateAllRowsDueToQuota(newQuota);

  if (targetMonth) {
    const safeUser = window.currentUser || "System";
    const parsedQuota = isNaN(Number(newQuota)) ? 4 : Math.max(0, Math.round(Number(newQuota)));
    toggleLoader(true);
    try {
      await setDoc(
        doc(db, "config", "payroll_settings"),
        {
          day_off_quota: parsedQuota,
          updated_at: new Date().toISOString()
        },
        { merge: true }
      );

      await insertAuditLog(
        "SETTING_DAYOFF_SUCCESS",
        `แก้ไขการตั้งค่าโควตา Day Off กลางของบริษัทเป็น ${parsedQuota} วัน (อ้างอิงรอบเดือน: ${targetMonth})`,
        safeUser
      );
    } catch (err) {
      console.error("Error saveDayOffQuotaToFirestore:", err.message);
      await insertAuditLog(
        "SETTING_DAYOFF_FAILED",
        `❌ แก้ไขโควตา Day Off ล้มเหลว (รอบเดือน: ${targetMonth}, ค่าที่พยายามตั้ง: ${newQuota}) | สาเหตุ: ${err.message}`,
        safeUser
      );
      alert("ระบบคำนวณหน้าจอใหม่แล้ว แต่บันทึกโควต้าลง Firestore ล้มเหลว: " + err.message);
    } finally {
      toggleLoader(false);
    }
  }
}

function recalculateAllRowsDueToQuota(quotaDayOff) {
  const rows = document.querySelectorAll(".payroll-row");
  rows.forEach(row => {
    const salaryTypeInput = row.querySelector(".p-salary-type");
    if (salaryTypeInput) {
      calculatePayrollRow(salaryTypeInput);
    }
  });
}

// =========================================================================
// 📅 ปฏิทินรายวันใต้ตาราง & Pop-up แก้ไขเวลารายวัน
// =========================================================================
async function toggleEmployeeCalendar(empId, empName) {
  const dropdownRow = document.getElementById(`calendar-dropdown-${empId}`);
  if (!dropdownRow) return;

  if (currentActiveCalendarEmpId === empId && !dropdownRow.classList.contains("d-none")) {
    closeActiveCalendar();
    return;
  }

  if (currentActiveCalendarEmpId && currentActiveCalendarEmpId !== empId) {
    closeActiveCalendar();
  }

  dropdownRow.classList.remove("d-none");
  currentActiveCalendarEmpId = empId;

  const targetGrid = document.querySelector(`.id-grid-target-${empId}`);
  const targetMonth = document.getElementById("payrollMonthSelect").value;

  if (calendarCacheByEmp[empId]) {
    currentActiveCalendarCache = calendarCacheByEmp[empId];
    renderCalendarGridStructure(empId, targetMonth, currentActiveCalendarCache, empName);
    return;
  }

  targetGrid.innerHTML = `<div class="text-center py-3 text-muted w-100" style="grid-column: span 7;">
    <span class="spinner-border spinner-border-sm"></span> กำลังดึงประวัติเวลาละเอียดรายวันจากคลาวด์...
  </div>`;

  try {
    const logsMap = await getEmployeeMonthlyDetails(empId, targetMonth);
    calendarCacheByEmp[empId] = logsMap;
    currentActiveCalendarCache = logsMap;
    renderCalendarGridStructure(empId, targetMonth, logsMap, empName);
  } catch (err) {
    targetGrid.innerHTML = `<div class="text-center text-danger py-3" style="grid-column: span 7;">โหลดข้อมูลขัดข้อง: ${err.message}</div>`;
  }
}

function closeActiveCalendar() {
  if (currentActiveCalendarEmpId) {
    const dropdownRow = document.getElementById(`calendar-dropdown-${currentActiveCalendarEmpId}`);
    if (dropdownRow) dropdownRow.classList.add("d-none");
    currentActiveCalendarEmpId = null;
    currentActiveCalendarCache = {};
  }
}

async function getEmployeeMonthlyDetails(empId, yearMonth) {
  if (!empId || !yearMonth) return {};

  const parts = yearMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const startDate = `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`;
  const nextMonthDate = `${year}-${String(month).padStart(2, "0")}-26`;

  const formattedEmpId = String(empId).padStart(4, "0");

  const logsSnap = await getDocs(
    query(
      collection(db, "hr", formattedEmpId, "attendance_logs"),
      where("date", ">=", startDate),
      where("date", "<", nextMonthDate)
    )
  );

  const logsMap = {};
  logsSnap.forEach(docSnap => {
    const logData = docSnap.data() || {};
    const logDate = logData.date || docSnap.id;
    if (logDate) {
      logsMap[logDate] = {
        status: logData.status || "Full",
        check_in1: logData.check_in1 || logData.check_in || "",
        check_out1: logData.check_out1 || logData.check_out || "",
        check_in2: logData.check_in2 || "",
        check_out2: logData.check_out2 || "",
        ot_hours: Number(logData.ot_hours) || 0,
        remarks: logData.remarks || logData.remark || "",
        today_work: logData.today_work || "",
        late_minutes: Number(logData.late_minutes) || 0,
        scan_issue: logData.scan_issue || ""
      };
    }
  });

  return logsMap;
}

function renderCalendarGridStructure(empId, yearMonth, logsMap, empName) {
  const targetGrid = document.querySelector(`.id-grid-target-${empId}`);
  if (!targetGrid) return;
  targetGrid.innerHTML = "";

  const parts = yearMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const startDate = new Date(prevYear, prevMonth - 1, 26);
  const endDate = new Date(year, month - 1, 25);

  let startDayOfWeek = startDate.getDay();
  if (startDayOfWeek === 0) startDayOfWeek = 7;

  for (let i = 1; i < startDayOfWeek; i++) {
    const emptyBox = document.createElement("div");
    emptyBox.className = "cal-day-box cal-empty-box";
    targetGrid.appendChild(emptyBox);
  }

  let currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    const dateISO =
      currentDate.getFullYear() +
      "-" +
      String(currentDate.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(currentDate.getDate()).padStart(2, "0");

    const displayDateNum = currentDate.getDate();
    const dayOfWeek = currentDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const log = logsMap[dateISO] || { status: "Off", ot_hours: 0 };

    let statusClass = "badge-off";
    if (log.status) {
      const s = String(log.status).toLowerCase().trim();

      if (s.includes("full/ph") || s === "f/ph") {
        statusClass = "badge-full-ph";
      } else if (s.includes("half/ph") || s === "h/ph") {
        statusClass = "badge-half-ph";
      } else if (s.startsWith("full")) {
        statusClass = "badge-full";
      } else if (s.startsWith("half")) {
        statusClass = "badge-half";
      } else if (s.startsWith("sick")) {
        statusClass = "badge-sick";
      } else if (s.startsWith("off") || s === "day off") {
        statusClass = "badge-off";
      } else if (s.startsWith("absent") || s.startsWith("abs")) {
        statusClass = "badge-absent";
      } else if (s.startsWith("late")) {
        statusClass = "badge-late";
      } else if (s.startsWith("leave") || s.startsWith("lev")) {
        statusClass = "badge-leave";
      } else if (s.startsWith("extra") || s === "ex") {
        statusClass = "badge-extra-day";
      } else if (s.startsWith("without") || s === "w.pay" || s === "w.p") {
        statusClass = "badge-without-pay";
      }
    }

    const dayBox = document.createElement("div");
    dayBox.className = "cal-day-box";
    if (isWeekend) dayBox.style.backgroundColor = "#fffcf0";

    const otHtml = log.ot_hours > 0 ? `<div class="cal-ot-text">OT: +${log.ot_hours}</div>` : "";

    dayBox.innerHTML = `
      <div class="cal-date-num">${displayDateNum}</div>
      <div class="cal-status-badge ${statusClass}">${escapeHtml(log.status || "Off")}</div>
      ${otHtml}
    `;

    dayBox.onclick = e => {
      e.stopPropagation();
      currentActiveCalendarCache = logsMap;
      openDailyEditModalPopup(empId, dateISO, empName, log);
    };

    targetGrid.appendChild(dayBox);
    currentDate.setDate(currentDate.getDate() + 1);
  }
}

function openDailyEditModalPopup(empId, dateStr, empName, currentLog) {
  document.getElementById("popEmpId").value = empId;
  document.getElementById("popDate").value = dateStr;
  document.getElementById("popEmpName").innerText = empName;
  document.getElementById("popDateFormatted").innerText = dateStr;

  const baseStatus = String(currentLog.status || "Full").startsWith("Late")
    ? "Late"
    : currentLog.status || "Full";

  document.getElementById("popStatus").value = baseStatus;
  document.getElementById("popOtHours").value = currentLog.ot_hours || 0;
  document.getElementById("popIn1").value = currentLog.check_in1 || "";
  document.getElementById("popOut1").value = currentLog.check_out1 || "";
  document.getElementById("popIn2").value = currentLog.check_in2 || "";
  document.getElementById("popOut2").value = currentLog.check_out2 || "";
  document.getElementById("popLateMin").value = currentLog.late_minutes || 0;
  document.getElementById("popScanIssue").value = currentLog.scan_issue || "";
  document.getElementById("popTodayWork").value = currentLog.today_work || "";
  document.getElementById("popRemarks").value = currentLog.remarks || "";

  const editModal = new bootstrap.Modal(document.getElementById("payrollDailyEditModal"));
  editModal.show();
}

async function savePayrollDailyModal() {
  const empId = String(document.getElementById("popEmpId").value).padStart(4, "0");
  const dateStr = document.getElementById("popDate").value;
  const empName = document.getElementById("popEmpName").innerText;
  const safeUser = window.currentUser || "System";

  const dailyRecord = {
    employee_id: empId,
    date: dateStr,
    status: document.getElementById("popStatus").value,
    ot_hours: parseFloat(document.getElementById("popOtHours").value) || 0,
    check_in1: document.getElementById("popIn1").value.trim(),
    check_out1: document.getElementById("popOut1").value.trim(),
    check_in2: document.getElementById("popIn2").value.trim(),
    check_out2: document.getElementById("popOut2").value.trim(),
    late_minutes: parseInt(document.getElementById("popLateMin").value, 10) || 0,
    scan_issue: document.getElementById("popScanIssue").value.trim(),
    today_work: document.getElementById("popTodayWork").value.trim(),
    remarks: document.getElementById("popRemarks").value.trim()
  };

  toggleLoader(true);

  try {
    await setDoc(
      doc(db, "hr", empId, "attendance_logs", dateStr),
      {
        date: dailyRecord.date,
        status: dailyRecord.status,
        today_work: dailyRecord.today_work,
        late_minutes: dailyRecord.late_minutes,
        scan_issue: dailyRecord.scan_issue,
        check_in1: dailyRecord.check_in1,
        check_out1: dailyRecord.check_out1,
        check_in2: dailyRecord.check_in2,
        check_out2: dailyRecord.check_out2,
        ot_hours: dailyRecord.ot_hours,
        remarks: dailyRecord.remarks,
        remark: dailyRecord.remarks,
        review_status: "reviewed",
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );

    await insertAuditLog(
      "ATTENDANCE_BATCH_SUCCESS",
      `แก้ไขเวลาทำงานรายวันจากหน้า Payroll ของ ${empName} (ID: ${empId}, วันที่: ${dateStr}) เป็นสถานะ ${dailyRecord.status}`,
      safeUser
    );

    const modalElement = document.getElementById("payrollDailyEditModal");
    const modalInstance = bootstrap.Modal.getInstance(modalElement);
    if (modalInstance) modalInstance.hide();

    if (!calendarCacheByEmp[empId]) calendarCacheByEmp[empId] = {};
    calendarCacheByEmp[empId][dateStr] = dailyRecord;
    currentActiveCalendarCache = calendarCacheByEmp[empId];

    const targetMonth = document.getElementById("payrollMonthSelect").value;
    renderCalendarGridStructure(empId, targetMonth, currentActiveCalendarCache, empName);
    recalculateSingleRowCountsLocal(empId);
  } catch (err) {
    console.error("Error savePayrollDailyModal:", err);
    alert("บันทึกข้อมูลรายวันไม่สำเร็จ: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

function recalculateSingleRowCountsLocal(empId) {
  const row = document.getElementById(`payroll-row-${empId}`);
  const logsMap = calendarCacheByEmp[empId] || currentActiveCalendarCache || {};
  if (!row) return;

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

  Object.keys(logsMap).forEach(date => {
    const log = logsMap[date];
    const statusLog = String(log.status || "").trim();

    if (statusLog.startsWith("Late")) {
      counts["Late"]++;
      if (statusLog.includes("Half")) {
        counts["Half"]++;
      } else {
        counts["Full"]++;
      }
    } else {
      const effectiveStatus = statusLog === "Day Off" ? "Off" : statusLog;
      if (counts[effectiveStatus] !== undefined) counts[effectiveStatus]++;
    }
    counts["OT"] += Number(log.ot_hours) || 0;
  });

  if (row.querySelector(".pr-work")) row.querySelector(".pr-work").innerText = counts["Full"];
  if (row.querySelector(".pr-half")) row.querySelector(".pr-half").innerText = counts["Half"];
  if (row.querySelector(".pr-sick")) row.querySelector(".pr-sick").innerText = counts["Sick"];
  if (row.querySelector(".pr-off")) row.querySelector(".pr-off").innerText = counts["Off"];
  if (row.querySelector(".pr-absent")) row.querySelector(".pr-absent").innerText = counts["Absent"];
  if (row.querySelector(".pr-late")) row.querySelector(".pr-late").innerText = counts["Late"];
  if (row.querySelector(".pr-leave")) row.querySelector(".pr-leave").innerText = counts["Leave"];
  if (row.querySelector(".pr-extra-day")) row.querySelector(".pr-extra-day").innerText = counts["Extra Day"];
  if (row.querySelector(".pr-full-ph")) row.querySelector(".pr-full-ph").innerText = counts["Full/PH"];
  if (row.querySelector(".pr-half-ph")) row.querySelector(".pr-half-ph").innerText = counts["Half/PH"];
  if (row.querySelector(".pr-ot")) row.querySelector(".pr-ot").innerText = counts["OT"];

  row.setAttribute("data-without-pay", counts["Without Pay"]);
  row.setAttribute("data-count-full-ph", counts["Full/PH"]);
  row.setAttribute("data-count-half-ph", counts["Half/PH"]);

  const typeSelect = row.querySelector(".p-salary-type");
  if (typeSelect) calculatePayrollRow(typeSelect);
}

// คลิกนอกพื้นที่กล่องปฏิทินเพื่อหุบเก็บ (ยกเว้นตอนเปิด Modal แก้ไขรายวันอยู่)
document.addEventListener("click", function (event) {
  if (!currentActiveCalendarEmpId) return;

  const modalEl = document.getElementById("payrollDailyEditModal");
  if (modalEl && modalEl.classList.contains("show")) return;

  const targetDropdown = document.getElementById(`calendar-dropdown-${currentActiveCalendarEmpId}`);
  const clickedElement = event.target;

  if (
    targetDropdown &&
    !targetDropdown.contains(clickedElement) &&
    !clickedElement.classList.contains("summary-number-trigger")
  ) {
    closeActiveCalendar();
  }
});

// =========================================================================
// 💾 บันทึกตั้งเบิกเงินเดือนแบบกลุ่มลง Firestore (writeBatch)
// =========================================================================
async function submitBatchPayrollData() {
  const month = document.getElementById("payrollMonthSelect").value;
  const currentShopFilter = document.getElementById("payrollShopSelect").value || "ทุกสาขา";
  if (!month) return alert("กรุณาระบุเดือนการตั้งเบิกก่อนครับ");

  const rows = document.querySelectorAll(".payroll-row");
  const payrollData = [];

  rows.forEach(row => {
    if (row.classList.contains("d-none")) return;

    payrollData.push({
      employee_id: String(row.getAttribute("data-emp-id")).padStart(4, "0"),
      count_work: row.querySelector(".pr-work")?.innerText || "0",
      count_half: row.querySelector(".pr-half")?.innerText || "0",
      count_sick: row.querySelector(".pr-sick")?.innerText || "0",
      count_off: row.querySelector(".pr-off")?.innerText || "0",
      count_absent: row.querySelector(".pr-absent")?.innerText || "0",
      count_late: row.querySelector(".pr-late")?.innerText || "0",
      count_leave: row.querySelector(".pr-leave")?.innerText || "0",
      count_extra_day: row.querySelector(".pr-extra-day")?.innerText || "0",
      count_full_ph: row.querySelector(".pr-full-ph")?.innerText || "0",
      count_half_ph: row.querySelector(".pr-half-ph")?.innerText || "0",
      count_ot: row.querySelector(".pr-ot")?.innerText || "0",
      count_without_pay: row.getAttribute("data-without-pay") || "0",
      salary_type: row.querySelector(".p-salary-type").value,

      earn_salary: row.querySelector(".p-earn-full").value.replace(/,/g, ""),
      earn_ot: row.querySelector(".p-earn-ot").value.replace(/,/g, ""),
      earn_extra_day: row.querySelector(".p-earn-extra").value.replace(/,/g, ""),
      earn_food: row.querySelector(".p-earn-food").value.replace(/,/g, ""),
      earn_housing: row.querySelector(".p-earn-housing").value.replace(/,/g, ""),
      earn_other: row.querySelector(".p-earn-other").value.replace(/,/g, ""),

      ded_advance: row.querySelector(".p-ded-advance").value.replace(/,/g, ""),
      ded_room: row.querySelector(".p-ded-room").value.replace(/,/g, ""),
      ded_social: row.querySelector(".p-ded-social").value.replace(/,/g, ""),
      ded_other: row.querySelector(".p-ded-other").value.replace(/,/g, ""),
      ded_absent: row.querySelector(".p-ded-absent").value.replace(/,/g, ""),
      ded_excess_off: row.querySelector(".p-ded-excess-off").value.replace(/,/g, ""),

      total_earn: row.querySelector(".p-total-earn").innerText.replace(/,/g, ""),
      total_ded: row.querySelector(".p-total-ded").innerText.replace(/,/g, ""),
      net_pay: row.querySelector(".p-net-pay").innerText.replace(/,/g, "")
    });
  });

  if (payrollData.length === 0) return alert("ไม่พบรายชื่อพนักงานที่แสดงอยู่เพื่อจัดส่งบันทึกครับ");

  if (
    !confirm(
      `ตรวจสอบความถูกต้องแล้ว ยืนยันบันทึกตั้งเบิกเงินเดือนรอบ ${month}\nเฉพาะร้าน/สาขา: [ ${currentShopFilter} ] รวมจำนวนทั้งสิ้น ${payrollData.length} คน ใช่หรือไม่?`
    )
  ) {
    return;
  }

  const safeUser = window.currentUser || "System";
  const recordCount = payrollData.length;
  toggleLoader(true);

  try {
    const CHUNK_SIZE = 450;
    for (let i = 0; i < payrollData.length; i += CHUNK_SIZE) {
      const chunk = payrollData.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      chunk.forEach(record => {
        const payrollRef = doc(db, "hr", record.employee_id, "payroll", month);
        batch.set(
          payrollRef,
          {
            month: month,
            attendance_summary: {
              work_days: Math.round(Number(record.count_work) || 0),
              half_days: Math.round(Number(record.count_half) || 0),
              sick_days: Math.round(Number(record.count_sick) || 0),
              off_days: Math.round(Number(record.count_off) || 0),
              absent_days: Math.round(Number(record.count_absent) || 0),
              late_days: Math.round(Number(record.count_late) || 0),
              leave_days: Math.round(Number(record.count_leave) || 0),
              extra_days: Math.round(Number(record.count_extra_day) || 0),
              without_pay_days: Math.round(Number(record.count_without_pay) || 0),
              full_ph_days: Math.round(Number(record.count_full_ph) || 0),
              half_ph_days: Math.round(Number(record.count_half_ph) || 0),
              ot_hours: Number(record.count_ot) || 0
            },
            earnings: {
              salary: Number(record.earn_salary) || 0,
              ot_pay: Number(record.earn_ot) || 0,
              extra_day_pay: Number(record.earn_extra_day) || 0,
              food_allowance: Number(record.earn_food) || 0,
              housing_allowance: Number(record.earn_housing) || 0,
              other_allowance: Number(record.earn_other) || 0
            },
            deductions: {
              advance: Number(record.ded_advance) || 0,
              room_rent: Number(record.ded_room) || 0,
              social_security: Number(record.ded_social) || 0,
              other_deduction: Number(record.ded_other) || 0,
              absent_deduction: Number(record.ded_absent) || 0,
              excess_day_off: Number(record.ded_excess_off) || 0
            },
            totals: {
              gross_earnings: Number(record.total_earn) || 0,
              gross_deductions: Number(record.total_ded) || 0,
              net_pay: Number(record.net_pay) || 0
            },
            updated_at: new Date().toISOString(),
            calculation_type: record.salary_type || "Daily"
          },
          { merge: true }
        );
      });

      await batch.commit();
    }

    await insertAuditLog(
      "PAYROLL_BATCH_SUCCESS",
      `อนุมัติตั้งเบิกและบันทึกข้อมูลเงินเดือนสำเร็จ รอบเดือน: ${month} (จำนวน: ${recordCount} คน)`,
      safeUser
    );

    alert(`🎉 บันทึกข้อมูลตั้งเบิกเงินเดือนพนักงาน รวม ${recordCount} คน เข้าสู่คลาวด์เรียบร้อยครับ!`);
    await loadPayrollGridData();
  } catch (err) {
    console.error("Error submitBatchPayrollData:", err);
    await insertAuditLog(
      "PAYROLL_BATCH_FAILED",
      `❌ บันทึกตั้งเบิกเงินเดือนล้มเหลว (รอบเดือน: ${month || "ไม่ระบุ"}, จำนวน: ${recordCount} คน) | สาเหตุ: ${err.message}`,
      safeUser
    );
    alert("เกิดข้อผิดพลาดในการบันทึกเงินเดือน: " + err.message);
  } finally {
    toggleLoader(false);
  }
}

// =========================================================================
// 🖨️ พิมพ์รายงานรวม PDF และ พิมพ์สลิปเงินเดือนแยกรายคน (ตัวจริง / สำเนา)
// =========================================================================
function printPayrollPDF() {
  const month = document.getElementById("payrollMonthSelect").value;
  const shopName = document.getElementById("payrollShopSelect").value || "ทุกสาขา/ร้านทั้งหมด";

  const printWindow = window.open("", "_blank");
  if (!printWindow) return alert("กรุณาอนุญาต Pop-up เพื่อพิมพ์รายงาน PDF");

  const headerClone = document.querySelector("#payrollSection table thead").cloneNode(true);
  const allThs = headerClone.querySelectorAll("th");
  allThs.forEach(th => {
    const cleanText = th.innerText.replace(/\s+/g, "");
    if (cleanText.includes("ดึงข้อมูล") || cleanText.includes("จากระบบ")) {
      th.remove();
    }
  });
  const tableHeaderHtml = headerClone.innerHTML;

  const rows = document.querySelectorAll(".payroll-row");
  let visibleRowsHtml = "";
  let paperRunningNum = 1;

  rows.forEach(row => {
    if (!row.classList.contains("d-none")) {
      const rowClone = row.cloneNode(true);

      rowClone.querySelector("td").innerText = paperRunningNum++;

      const syncButton = rowClone.querySelector("button");
      if (syncButton) {
        const parentCell = syncButton.parentElement;
        if (parentCell) parentCell.remove();
      }

      const selects = rowClone.querySelectorAll("select");
      selects.forEach(select => {
        const val = select.value === "Monthly" ? "แบบเดือน" : "แบบวัน";
        const parentCell = select.parentElement;
        parentCell.innerHTML = `<strong>${val}</strong>`;
      });

      const inputs = rowClone.querySelectorAll("input");
      inputs.forEach(input => {
        const value = parseFloat(input.value.replace(/,/g, "")) || 0;
        const parentCell = input.parentElement;
        parentCell.innerHTML = value > 0 ? value.toLocaleString() : "0";
        parentCell.className = "text-end";
      });

      visibleRowsHtml += rowClone.outerHTML;
    }
  });

  const grandTotalEarn = document.getElementById("grandTotalEarn").innerText;
  const grandTotalDed = document.getElementById("grandTotalDed").innerText;
  const grandNetPay = document.getElementById("grandNetPay").innerText;

  printWindow.document.write(`
    <html>
    <head>
      <title>รายงานสรุปตั้งเบิกเงินเดือน_${month}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
        body { 
          font-family: 'Sarabun', sans-serif; 
          font-size: 11px; 
          padding: 20px; 
          color: #000000; 
          background: #fff;
        }
        .report-header {
          text-align: center;
          margin-bottom: 5px;
        }
        .report-header strong {
          font-size: 16px;
          letter-spacing: 0.5px;
        }
        .report-header span {
          font-size: 11px;
          color: #000000;
        }
        .meta-info {
          display: flex;
          justify-content: space-between;
          margin-top: 15px;
          margin-bottom: 5px;
          font-size: 11px;
        }
        table { 
          width: 100%; 
          border-collapse: collapse; 
          margin-top: 5px; 
        }
        th, td { 
          border: 1px solid #000000 !important; 
          padding: 5px 4px !important; 
          font-size: 10px; 
          vertical-align: middle; 
          text-align: center; 
        }
        th {
          background: #f2f2f2 !important;
          font-weight: 600;
        }
        .text-start { text-align: left !important; }
        .text-end { text-align: right !important; }
        
        .row-total td {
          font-weight: bold;
          background: #e6e6e6 !important;
        }
        
        @media print {
          body { padding: 0; }
          th { background: #f2f2f2 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .row-total td { background: #e6e6e6 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      </style>
    </head>
    <body onload="setTimeout(() => { window.print(); window.close(); }, 600)">
      
      <div class="report-header">
        <strong>ใบสรุปตั้งเบิกเงินเดือนพนักงาน (อะตอม กรุ๊ป)</strong><br>
        <span>สำเนาตารางประมวลผลข้อมูลบัญชีและการเบิกจ่ายเงินสด</span>
      </div>
      
      <div class="meta-info">
        <div>รอบเดือนบัญชี: <strong>${month}</strong> &nbsp;&nbsp;|&nbsp;&nbsp; คัดกรองเฉพาะ: <strong>${shopName}</strong></div>
        <div>พนักงานรวมในใบ: <strong>${paperRunningNum - 1} คน</strong></div>
      </div>
      
      <table>
        <thead>${tableHeaderHtml}</thead>
        <tbody>
          ${visibleRowsHtml}
          <tr class="row-total text-end">
            <td colspan="30" class="py-2 pe-3 text-start">ยอดรวมสุทธิเฉพาะรายการที่ออกเอกสาร:</td>
            <td class="text-end">${grandTotalEarn}</td>
            <td class="text-end">${grandTotalDed}</td>
            <td class="text-end">${grandNetPay}</td>
          </tr>
        </tbody>
      </table>
    </body>
    </html>
  `);
  printWindow.document.close();
}

async function printIndividualSlipsPDF() {
  const month = document.getElementById("payrollMonthSelect").value;
  const rows = document.querySelectorAll(".payroll-row");

  const visibleRows = Array.from(rows).filter(r => !r.classList.contains("d-none"));
  if (visibleRows.length === 0) return alert("ไม่พบข้อมูลพนักงานที่จะจัดพิมพ์ใบเสร็จครับ");

  const printWindow = window.open("", "_blank");
  if (!printWindow) return alert("กรุณาอนุญาต Pop-up เพื่อพิมพ์สลิปเงินเดือน");

  toggleLoader(true);
  try {
    await Promise.all(
      visibleRows.map(async row => {
        const empId = row.getAttribute("data-emp-id");
        const name = row.querySelector("td:nth-child(2)").innerText;
        const calendarTarget = document.querySelector(`.id-grid-target-${empId}`);

        if (!calendarTarget || calendarTarget.children.length === 0) {
          const logsMap = calendarCacheByEmp[empId] || (await getEmployeeMonthlyDetails(empId, month));
          calendarCacheByEmp[empId] = logsMap;
          renderCalendarGridStructure(empId, month, logsMap, name);
        }
      })
    );
  } finally {
    toggleLoader(false);
  }

  let slipsHtml = "";
  let countSlips = 0;

  visibleRows.forEach(row => {
    countSlips++;

    const empId = row.getAttribute("data-emp-id");
    const name = row.querySelector("td:nth-child(2)").innerText;
    const nick = row.querySelector("td:nth-child(3)").innerText;
    const position = row.querySelector("td:nth-child(4)").innerText;

    const w_full = row.querySelector(".pr-work")?.innerText || "0";
    const w_half = row.querySelector(".pr-half")?.innerText || "0";
    const w_sick = row.querySelector(".pr-sick")?.innerText || "0";
    const w_off = row.querySelector(".pr-off")?.innerText || "0";
    const w_absent = row.querySelector(".pr-absent")?.innerText || "0";
    const w_late = row.querySelector(".pr-late")?.innerText || "0";
    const w_leave = row.querySelector(".pr-leave")?.innerText || "0";
    const w_extra = row.querySelector(".pr-extra-day")?.innerText || "0";
    const w_full_ph = row.querySelector(".pr-full-ph")?.innerText || "0";
    const w_half_ph = row.querySelector(".pr-half-ph")?.innerText || "0";
    const w_ot = row.querySelector(".pr-ot")?.innerText || "0";

    const earn_salary = row.querySelector(".p-earn-other").value;
    const earn_food = row.querySelector(".p-earn-food").value;
    const earn_housing = row.querySelector(".p-earn-housing").value;
    const earn_full = row.querySelector(".p-earn-full").value;
    const earn_ot = row.querySelector(".p-earn-ot").value;
    const earn_extra = row.querySelector(".p-earn-extra").value;

    const ded_advance = row.querySelector(".p-ded-advance").value;
    const ded_room = row.querySelector(".p-ded-room").value;
    const ded_social = row.querySelector(".p-ded-social").value;
    const ded_other = row.querySelector(".p-ded-other").value;
    const ded_absent = row.querySelector(".p-ded-absent").value;
    const ded_excess_off = row.querySelector(".p-ded-excess-off").value;

    const total_earn = row.querySelector(".p-total-earn").innerText;
    const total_ded = row.querySelector(".p-total-ded").innerText;
    const net_pay = row.querySelector(".p-net-pay").innerText;

    const calendarTarget = document.querySelector(`.id-grid-target-${empId}`);
    let calendarCellsHtml = "";
    if (calendarTarget) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = calendarTarget.innerHTML;

      tempDiv.querySelectorAll("div").forEach(cell => {
        if (cell.innerText && /\b(off)\b/i.test(cell.innerText)) {
          cell.style.setProperty("color", "#dc3545", "important");
          cell.classList.add("fw-bold");
          cell.querySelectorAll("*").forEach(child => {
            child.style.setProperty("color", "#dc3545", "important");
          });
        }
      });

      calendarCellsHtml = tempDiv.innerHTML;
    }

    let employeeSlipBlocks = "";
    const docTypes = ["ตัวจริง", "สำเนา"];

    docTypes.forEach((typeLabel, tIdx) => {
      employeeSlipBlocks += `
        <div class="slip-block">
          <div class="slip-header">
            <strong>ใบแจ้ง / Payslip (${typeLabel})</strong><br>
            <span>รอบประจำ: ${month}</span>
          </div>
          
          <div class="emp-meta">
            ชื่อ: <strong>${name}</strong> &nbsp;&nbsp;|&nbsp;&nbsp; ชื่อเล่น: <strong>${nick}</strong> &nbsp;&nbsp;|&nbsp;&nbsp; ตำแหน่ง: <strong>${position}</strong>
          </div>
          
          <div class="slip-calendar-wrapper">
            <div class="payroll-calendar-grid bg-light py-0 px-1 border">
              <div class="cal-day-header">จ.</div>
              <div class="cal-day-header">อ.</div>
              <div class="cal-day-header">พ.</div>
              <div class="cal-day-header">พฤ.</div>
              <div class="cal-day-header">ศ.</div>
              <div class="cal-day-header text-danger fw-bold">ส.</div>
              <div class="cal-day-header text-danger fw-bold">อา.</div>
            </div>
            <div class="payroll-calendar-grid border-start border-end border-bottom p-1" style="background-color: #fffdf7; margin-bottom: 4px;">
              ${calendarCellsHtml}
            </div>
          </div>
          
          <table class="table-attendance">
            <thead>
              <tr>
                <th>Full</th>
                <th>Half</th>
                <th>Sick</th>
                <th class="text-danger">Off</th>
                <th>Absent</th>
                <th>Late</th>
                <th>Leave</th>
                <th>Extra Day</th>
                <th>Full/PH</th>
                <th>Half/PH</th>
                <th>OT (ชม.)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${w_full}</td>
                <td>${w_half}</td>
                <td>${w_sick}</td>
                <td class="text-danger ${parseFloat(w_off) > 0 ? "text-bold" : ""}">${w_off}</td>
                <td class="${parseFloat(w_absent) > 0 ? "text-bold" : ""}">${w_absent}</td>
                <td>${w_late}</td>
                <td>${w_leave}</td>
                <td>${w_extra}</td>
                <td>${w_full_ph}</td>
                <td>${w_half_ph}</td>
                <td>${w_ot}</td>
              </tr>
            </tbody>
          </table>
          
          <table class="table-money-matrix">
            <thead>
              <tr>
                <th width="35%">รายการรายรับ</th>
                <th width="15%" class="text-end">จำนวนเงิน</th>
                <th width="35%">รายการรายจ่าย</th>
                <th width="15%" class="text-end">จำนวนเงิน</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>เงินเดือน</td>
                <td class="text-end">${earn_salary}</td>
                <td>Advance (เบิกล่วงหน้า)</td>
                <td class="text-end">${ded_advance}</td>
              </tr>
              <tr>
                <td>ค่าอาหาร</td>
                <td class="text-end">${earn_food}</td>
                <td>ค่าห้องพัก</td>
                <td class="text-end">${ded_room}</td>
              </tr>
              <tr>
                <td>ค่าที่พักนอก</td>
                <td class="text-end">${earn_housing}</td>
                <td>หัก ปกส</td>
                <td class="text-end">${ded_social}</td>
              </tr>
              <tr>
                <td>ค่า Full</td>
                <td class="text-end">${earn_full}</td>
                <td>หักอื่นๆ</td>
                <td class="text-end">${ded_other}</td>
              </tr>
              <tr>
                <td>ค่า OT</td>
                <td class="text-end">${earn_ot}</td>
                <td>หักขาดงาน</td>
                <td class="text-end">${ded_absent}</td>
              </tr>
              <tr>
                <td>ค่า Extra Day</td>
                <td class="text-end">${earn_extra}</td>
                <td>หัก Day Off เกิน</td>
                <td class="text-end">${ded_excess_off}</td>
              </tr>
              
              <tr class="row-summary">
                <td>รวมรับทั้งสิ้น</td>
                <td class="text-end text-underline">${total_earn}</td>
                <td>รวมจ่ายทั้งสิ้น</td>
                <td class="text-end text-underline">${total_ded}</td>
              </tr>
              
              <tr class="row-net">
                <td colspan="2" class="border-none"></td>
                <td class="bg-dark-text">คงเหลือสุทธิ (Net Pay)</td>
                <td class="text-end bg-dark-text underline-double">${net_pay}</td>
              </tr>
            </tbody>
          </table>
          
          <div class="slip-footer">
            <div class="sign-space">ลงชื่อ: ___________________________</div>
            <div class="sign-space">ผู้ออก: ___________________________</div>
          </div>
        </div>
      `;

      if (tIdx === 0) {
        employeeSlipBlocks += `<div class="slip-divider"></div>`;
      }
    });

    slipsHtml += `<div class="slip-page">${employeeSlipBlocks}</div>`;
  });

  if (countSlips === 0) return alert("ไม่พบข้อมูลพนักงานที่จะจัดพิมพ์ใบเสร็จครับ");

  printWindow.document.write(`
    <html>
    <head>
      <title>ใบเสร็จเงินเดือนพนักงานรวมไฟล์_${month}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
        body {
          font-family: 'Sarabun', sans-serif;
          margin: 0;
          padding: 0;
          background: #fff;
          color: #000;
          font-size: 10px;
          line-height: 1.2;
        }
        .slip-page {
          padding: 10mm 15mm;
          margin: 0 auto;
          width: 210mm;
          height: 297mm;
          max-height: 297mm;
          box-sizing: border-box;
          page-break-after: always;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          overflow: hidden;
        }
        .slip-page:last-child {
          page-break-after: avoid;
        }
        .slip-block {
          width: 100%;
          box-sizing: border-box;
        }
        .slip-header {
          text-align: center;
          margin-bottom: 2px;
        }
        .slip-header strong {
          font-size: 11px;
          letter-spacing: 0.3px;
        }
        .slip-header span {
          font-size: 8.5px;
          color: #444;
        }
        .emp-meta {
          border: 1px solid #000;
          padding: 1px 5px;
          margin-bottom: 3px;
          font-size: 9px;
          background: #fdfdfd;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 3px;
        }
        th, td {
          border: 1px solid #000;
          padding: 1.5px 3px !important;
          font-size: 9px;
          vertical-align: middle;
        }
        th {
          background: #f2f2f2;
          font-weight: 600;
        }
        .table-attendance td {
          text-align: center;
        }
        .text-end { text-align: right !important; }
        .text-bold { font-weight: bold; }
        .fw-bold { font-weight: bold !important; }
        .border-none { border: none !important; }
        
        .row-summary td {
          font-weight: bold;
          background: #f9f9f9;
        }
        .text-underline {
          text-decoration: underline;
        }
        .underline-double {
          border-bottom: 2px double #000 !important;
        }
        .row-net td.bg-dark-text {
          font-weight: bold;
          font-size: 9.5px;
          background: #e6e6e6 !important;
        }
        
        .slip-divider {
          width: 100%;
          border-top: 1px dashed #666 !important;
          margin: 100px 0 50px 0 !important;
          height: 0 !important;
          font-size: 0 !important;
          line-height: 0 !important;
        }
        
        .slip-footer {
          margin-top: 3px;
          margin-bottom: 1px;
          display: flex;
          justify-content: space-between;
        }
        .sign-space {
          font-size: 9px;
        }
        
        .slip-calendar-wrapper {
          margin-top: 1px;
          margin-bottom: 2px;
        }
        .payroll-calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 1px;
        }
        .cal-day-header {
          text-align: center;
          font-size: 7px;
          padding: 1px 0;
        }
        .text-danger { color: #dc3545 !important; }
        
        .payroll-calendar-grid > div {
          border: 1px solid #ddd;
          background: #fff;
          padding: 1px !important;
          font-size: 8.5px !important;
          text-align: center;
          min-height: 13px !important;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          box-sizing: border-box;
        }
        .payroll-calendar-grid div, 
        .payroll-calendar-grid span {
          font-size: 8.5px !important;
          padding: 0 !important;
          margin: 0 !important;
          line-height: 1 !important;
        }
        
        @media print {
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .slip-page {
            padding: 10mm 15mm;
            height: 297mm;
            max-height: 297mm;
          }
        }
      </style>
    </head>
    <body onload="setTimeout(() => { window.print(); window.close(); }, 700)">
      ${slipsHtml}
    </body>
    </html>
  `);
  printWindow.document.close();
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
window.loadPayrollGridData = loadPayrollGridData;
window.formatInputWithCommas = formatInputWithCommas;
window.onBaseSalaryInputChange = onBaseSalaryInputChange;
window.filterPayrollByShop = filterPayrollByShop;
window.handleDayOffQuotaChange = handleDayOffQuotaChange;
window.syncHousingRow = syncHousingRow;
window.syncAllHousingData = syncAllHousingData;
window.calculatePayrollRow = calculatePayrollRow;
window.toggleEmployeeCalendar = toggleEmployeeCalendar;
window.closeActiveCalendar = closeActiveCalendar;
window.savePayrollDailyModal = savePayrollDailyModal;
window.submitBatchPayrollData = submitBatchPayrollData;
window.printPayrollPDF = printPayrollPDF;
window.printIndividualSlipsPDF = printIndividualSlipsPDF;