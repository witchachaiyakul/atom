// public/hr/js/warning.js
import { db } from "../../js/firestore.js";
import { insertAuditLog, initHRPageSession } from "./hr-log.js";
import {
  collection,
  collectionGroup,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let currentWarningReportList = [];

// =========================================================================
// 🚨 ระบบรายงานสรุปความผิดปกติรายบุคคล & ออกใบเตือน (Warning โมดูล)
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const user = initHRPageSession();
  if (!user) return;

  toggleLoader(false);

  const monthInput = document.getElementById("report-month");
  if (monthInput && !monthInput.value) {
    const now = new Date();
    const currentMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    monthInput.value = currentMonth;
  }

  await loadWarningReportData();
});

function backToHomeFromWarning() {
  location.href = "index.html";
}

async function loadWarningReportData() {
  const tbody = document.getElementById("warning-report-list");
  const loading = document.getElementById("warning-loading");
  const emptyAlert = document.getElementById("warning-empty");

  tbody.innerHTML = "";
  loading.classList.remove("d-none");
  emptyAlert.classList.add("d-none");

  const selectedMonth = document.getElementById("report-month").value;
  if (!selectedMonth) {
    alert("กรุณาระบุรอบเดือนก่อนค้นหาครับ");
    loading.classList.add("d-none");
    return;
  }

  try {
    const data = await getIrregularAttendanceData(selectedMonth);
    currentWarningReportList = data;
    loading.classList.add("d-none");

    if (!data || data.length === 0) {
      emptyAlert.classList.remove("d-none");
      return;
    }

    // วนลูปนำข้อมูลพนักงานแต่ละคนมาเรนเดอร์ (1 คน = 1 แถวใหญ่)
    data.forEach(item => {
      // 1. สร้างข้อความสรุปภาพรวมความผิด
      let summaryHtml = "";
      if (item.total_late_count > 0) {
        summaryHtml += `<div class="badge bg-warning text-dark d-block mb-1 p-2 text-start"><i class="bi bi-clock-history"></i> สาย: <b>${item.total_late_count}</b> ครั้ง (${item.total_late_minutes} นาที)</div>`;
      }
      if (item.total_scan_issues > 0) {
        summaryHtml += `<div class="badge bg-danger d-block p-2 text-start"><i class="bi bi-shield-exclamation"></i> ลืมสแกนนิ้ว/ปัญหา: <b>${item.total_scan_issues}</b> ครั้ง</div>`;
      }

      // 2. แตกประวัติย่อยของแต่ละวันที่ทำผิดกฎมาสแต็กรวมกันในคอลัมน์รายละเอียด
      let detailsHtml = `<div class="p-1" style="max-height: 180px; overflow-y: auto;">`;
      item.dates_details.forEach(detail => {
        let logBadge = "";
        if (detail.late_minutes > 0) {
          logBadge += `<span class="text-warning fw-bold">[สาย ${detail.late_minutes} น.]</span> `;
        }
        if (detail.scan_issue) {
          logBadge += `<span class="text-danger fw-bold">[🚨 ${escapeHtml(detail.scan_issue)}]</span> `;
        }

        detailsHtml += `
          <div class="mb-2 pb-1 border-bottom border-light text-start small">
            📆 <b class="text-dark">${escapeHtml(detail.date)}</b> | ${logBadge} 
            <span class="text-secondary">(เข้า1: <b>${escapeHtml(detail.check_in1 || "-")}</b> / ออก1: <b>${escapeHtml(detail.check_out1 || "-")}</b>)</span>
            ${detail.remarks ? `<div class="text-muted ps-3 fst-italic">↳ หมายเหตุ: ${escapeHtml(detail.remarks)}</div>` : ""}
          </div>
        `;
      });
      detailsHtml += `</div>`;

      // 3. ประกอบโครงแถวตาราง
      const row = document.createElement("tr");
      row.innerHTML = `
        <td class="text-center font-monospace fw-bold bg-light align-top pt-3">${escapeHtml(item.employee_id)}</td>
        <td class="text-start align-top pt-3">
          <strong class="fs-6">${escapeHtml(item.name)}</strong> (${escapeHtml(item.nickname)})
          <div class="text-muted small mt-1"><i class="bi bi-briefcase"></i> แผนก: ${escapeHtml(item.position)}</div>
          <div class="text-primary small"><i class="bi bi-geo-alt"></i> ประจำที่: ${escapeHtml(item.shop)}</div>
        </td>
        <td class="align-top pt-3">${summaryHtml}</td>
        <td class="text-start align-top">${detailsHtml}</td>
        <td class="text-center align-top pt-3">
          <button class="btn btn-danger btn-sm fw-bold w-100 shadow-sm py-2" onclick="actionIssueWarning('${escapeHtml(item.employee_id)}', '${escapeHtml(selectedMonth)}')">
            <i class="bi bi-file-earmark-pdf"></i> ออกใบเตือนรวม
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    loading.classList.add("d-none");
    alert("เกิดข้อผิดพลาดจากระบบ: " + err.message);
  }
}

async function getIrregularAttendanceData(monthStr) {
  try {
    if (!monthStr) return [];

    // ==========================================
    // 1. ตรรกะคำนวณช่วงวันที่: 25 เดือนก่อนหน้า - 26 เดือนปัจจุบัน
    // ==========================================
    const parts = monthStr.split("-"); // ["2026", "06"]
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);

    let prevYear = year;
    let prevMonth = month - 1;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear = year - 1;
    }

    const prevMonthStr = String(prevMonth).padStart(2, "0");
    const targetMonthStr = String(month).padStart(2, "0");

    const startRange = `${prevYear}-${prevMonthStr}-25`; // เช่น 2026-05-25
    const endRange = `${year}-${targetMonthStr}-26`; // เช่น 2026-06-26

    // ==========================================
    // 2. ดึงข้อมูลพนักงาน Map โครงสร้างใหม่ (profile / employment)
    // ==========================================
    const empSnap = await getDocs(collection(db, "hr"));
    const empMap = {};
    const empIdsList = [];

    empSnap.forEach(docSnap => {
      const emp = docSnap.data() || {};
      const empId = String(emp.employee_id || emp.id || docSnap.id).trim().padStart(4, "0");

      const profile = emp.profile || {};
      const employment = emp.employment || {};

      empMap[empId] = {
        name: profile.name || emp.name || "-",
        nickname: profile.nickname || profile.nick || emp.nickname || emp.nick || "-",
        shop: employment.shop || employment.workplace || emp.shop || emp.workplace || "-",
        position: employment.position || emp.position || "-"
      };
      empIdsList.push(empId);
    });

    // ==========================================
    // 3. ใช้ Collection Group Query ดึงล็อกเวลาทำงานตาม Range ช่วงวันที่ตั้งไว้
    // ==========================================
    const employeeGroups = {};

    const processAttendanceRecord = (empId, docId, logFields) => {
      const status = logFields.status ? String(logFields.status) : "";
      const lateMinutes = logFields.late_minutes !== undefined ? Number(logFields.late_minutes) : 0;
      const scanIssue = logFields.scan_issue ? String(logFields.scan_issue).trim() : "";
      const remarks = logFields.remarks || logFields.remark ? String(logFields.remarks || logFields.remark) : "";

      // เช็กเงื่อนไขความผิดปกติ
      const isLateCondition = status.startsWith("Late") && lateMinutes > 0;
      const isScanIssueCondition = scanIssue !== "";

      if (isLateCondition || isScanIssueCondition) {
        if (!employeeGroups[empId]) {
          const empInfo = empMap[empId] || {
            name: "ไม่พบข้อมูลพนักงาน",
            nickname: "-",
            shop: "-",
            position: "-"
          };
          employeeGroups[empId] = {
            employee_id: empId,
            name: empInfo.name,
            nickname: empInfo.nickname,
            shop: empInfo.shop,
            position: empInfo.position,
            total_late_count: 0,
            total_late_minutes: 0,
            total_scan_issues: 0,
            dates_details: []
          };
        }

        const currentGroup = employeeGroups[empId];

        if (isLateCondition) {
          currentGroup.total_late_count++;
          currentGroup.total_late_minutes += lateMinutes;
        }
        if (isScanIssueCondition) {
          currentGroup.total_scan_issues++;
        }

        currentGroup.dates_details.push({
          date: logFields.date || docId,
          status: status,
          late_minutes: lateMinutes,
          scan_issue: scanIssue,
          remarks: remarks,
          check_in1: logFields.check_in1 || logFields.check_in || "",
          check_out1: logFields.check_out1 || logFields.check_out || "",
          check_in2: logFields.check_in2 || "",
          check_out2: logFields.check_out2 || ""
        });
      }
    };

    try {
      const logsQuery = query(
        collectionGroup(db, "attendance_logs"),
        where("date", ">=", startRange),
        where("date", "<=", endRange)
      );
      const logsSnap = await getDocs(logsQuery);

      logsSnap.forEach(logDoc => {
        const parentEmpDoc = logDoc.ref.parent.parent;
        if (!parentEmpDoc) return;
        const empId = String(parentEmpDoc.id).trim().padStart(4, "0");
        processAttendanceRecord(empId, logDoc.id, logDoc.data() || {});
      });
    } catch (cgErr) {
      // Fallback กรณียังไม่ได้สร้าง Composite Index สำหรับ Collection Group
      console.warn("Fallback to per-employee attendance_logs fetch:", cgErr.message);
      await Promise.all(
        empIdsList.map(async empId => {
          try {
            const empLogsSnap = await getDocs(
              query(
                collection(db, "hr", empId, "attendance_logs"),
                where("date", ">=", startRange),
                where("date", "<=", endRange)
              )
            );
            empLogsSnap.forEach(logDoc => {
              processAttendanceRecord(empId, logDoc.id, logDoc.data() || {});
            });
          } catch (e) {
            console.error(`Error fetching logs for ${empId}:`, e);
          }
        })
      );
    }

    // แปลงผลลัพธ์จาก Object Group เป็น Array และเรียงลำดับวันที่ + รหัสพนักงาน
    const finalReportArray = Object.values(employeeGroups);
    finalReportArray.forEach(group => {
      group.dates_details.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    });
    finalReportArray.sort((a, b) => a.employee_id.localeCompare(b.employee_id));

    return finalReportArray;
  } catch (e) {
    console.error("🚨 Error in getIrregularAttendanceData:", e.message);
    throw new Error("ระบบหลังบ้านขัดข้อง: " + e.message);
  }
}

// =========================================================================
// 🖨️ สร้างและสั่งพิมพ์เอกสารใบเตือนรวมรายบุคคล (#printWarningArea)
// =========================================================================
async function actionIssueWarning(empId, selectedMonth) {
  const empRecord = currentWarningReportList.find(item => item.employee_id === empId);
  if (!empRecord) {
    alert("ไม่พบข้อมูลรายละเอียดของพนักงานรหัส " + empId);
    return;
  }

  const todayStr = new Date().toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const parts = selectedMonth.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const periodText = `25/${String(prevMonth).padStart(2, "0")}/${prevYear} - 26/${String(month).padStart(2, "0")}/${year}`;

  let rowsHtml = "";
  empRecord.dates_details.forEach((d, idx) => {
    const issueDesc = [];
    if (d.late_minutes > 0) issueDesc.push(`มาสาย ${d.late_minutes} นาที`);
    if (d.scan_issue) issueDesc.push(`ปัญหาสแกนเวลา: ${d.scan_issue}`);

    const timeText = `เข้า1: ${d.check_in1 || "-"} / ออก1: ${d.check_out1 || "-"}${
      d.check_in2 || d.check_out2 ? ` | เข้า2: ${d.check_in2 || "-"} / ออก2: ${d.check_out2 || "-"}` : ""
    }`;

    rowsHtml += `
      <tr>
        <td style="text-align: center;">${idx + 1}</td>
        <td style="text-align: center;">${escapeHtml(d.date)}</td>
        <td>${escapeHtml(issueDesc.join(", "))}</td>
        <td style="text-align: center;">${escapeHtml(timeText)}</td>
        <td>${escapeHtml(d.remarks || "-")}</td>
      </tr>
    `;
  });

  const printArea = document.getElementById("printWarningArea");
  printArea.innerHTML = `
    <div class="warning-doc-box">
      <div style="text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 15px;">
        <h2 style="margin: 0; font-size: 20px; font-weight: 700;">หนังสือตักเตือนความผิดวินัยการทำงาน (ใบเตือน)</h2>
        <div style="font-size: 13px; margin-top: 4px;">บริษัท อะตอม กรุ๊ป จำกัด (Atom Group Phi Phi)</div>
      </div>

      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <div><strong>รอบการตรวจสอบ:</strong> ${escapeHtml(selectedMonth)} (${periodText})</div>
        <div><strong>วันที่ออกเอกสาร:</strong> ${todayStr}</div>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 13px;">
        <tr>
          <td style="padding: 4px 0; width: 50%;"><strong>ชื่อ-นามสกุล:</strong> ${escapeHtml(empRecord.name)} (${escapeHtml(empRecord.nickname)})</td>
          <td style="padding: 4px 0; width: 50%;"><strong>รหัสพนักงาน:</strong> ${escapeHtml(empRecord.employee_id)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0;"><strong>ตำแหน่ง / แผนก:</strong> ${escapeHtml(empRecord.position)}</td>
          <td style="padding: 4px 0;"><strong>สาขา / สถานที่ปฏิบัติงาน:</strong> ${escapeHtml(empRecord.shop)}</td>
        </tr>
      </table>

      <p style="margin-bottom: 8px; text-indent: 2em;">
        เนื่องด้วยฝ่ายบุคคลได้ตรวจสอบบันทึกเวลาเข้า-ออกงานของท่านในรอบเดือน <strong>${escapeHtml(selectedMonth)}</strong> 
        พบว่าท่านได้กระทำผิดระเบียบข้อบังคับเกี่ยวกับการทำงานของบริษัท โดยมีรายละเอียดสถิติความผิดปกติดังนี้:
      </p>

      <div style="background: #f8f9fa; border: 1px solid #000; padding: 8px 12px; margin-bottom: 12px; font-weight: 600;">
        • มาสายรวมทั้งสิ้น: ${empRecord.total_late_count} ครั้ง (รวม ${empRecord.total_late_minutes} นาที) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
        • ลืมสแกนนิ้ว / สแกนผิดปกติ: ${empRecord.total_scan_issues} ครั้ง
      </div>

      <table class="warning-table-print">
        <thead>
          <tr>
            <th width="7%">ลำดับ</th>
            <th width="16%">วันที่</th>
            <th width="27%">รายละเอียดความผิดปกติ</th>
            <th width="28%">บันทึกเวลาสแกน</th>
            <th width="22%">หมายเหตุ</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <p style="margin-top: 12px; text-indent: 2em;">
        บริษัทฯ จึงขอออกหนังสือตักเตือนฉบับนี้เพื่อให้ท่านปรับปรุงแก้ไขพฤติกรรมการปฏิบัติงานให้ถูกต้องตามระเบียบของบริษัทอย่างเคร่งครัด 
        หากท่านยังคงกระทำผิดซ้ำอีก บริษัทฯ จำเป็นต้องดำเนินการลงโทษทางวินัยในขั้นที่สูงขึ้นตามระเบียบข้อบังคับต่อไป
      </p>

      <div style="display: flex; justify-content: space-between; margin-top: 40px; text-align: center;">
        <div style="width: 45%;">
          <div>ลงชื่อ ...................................................... พนักงาน</div>
          <div style="margin-top: 4px;">(${escapeHtml(empRecord.name)})</div>
          <div style="margin-top: 4px;">วันที่ ........../........../..........</div>
        </div>
        <div style="width: 45%;">
          <div>ลงชื่อ ...................................................... ผู้ออกใบเตือน</div>
          <div style="margin-top: 4px;">(ฝ่ายทรัพยากรบุคคล / ผู้จัดการสาขา)</div>
          <div style="margin-top: 4px;">วันที่ ........../........../..........</div>
        </div>
      </div>
    </div>
  `;

  const safeUser = window.currentUser || "System";
  await insertAuditLog(
    "WARNING_LETTER_ISSUED",
    `ออกเอกสารใบเตือนรวมของ ${empRecord.name} (ID: ${empId}, รอบเดือน: ${selectedMonth}) | สาย ${empRecord.total_late_count} ครั้ง, ปัญหาสแกน ${empRecord.total_scan_issues} ครั้ง`,
    safeUser
  );

  window.print();
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
window.backToHomeFromWarning = backToHomeFromWarning;
window.loadWarningReportData = loadWarningReportData;
window.actionIssueWarning = actionIssueWarning;