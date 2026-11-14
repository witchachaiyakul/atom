// public/js/audit-log.js
import { db, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit, 
  documentId 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let isSearchingLogs = false;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("AuditLogSection")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  await loadUserDropdownOptions();
  await searchAuditLogs();
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าค้นหา Audit Logs");
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
// 👥 2. โหลดรายชื่อผู้ใช้งานใส่ Dropdown (#searchUser)
// ============================================================================
async function loadUserDropdownOptions() {
  const selectEl = document.getElementById("searchUser");
  if (!selectEl) return;

  const userMap = new Map(); // userId -> userName

  try {
    const usersSnap = await getDocs(collection(db, "users"));
    usersSnap.forEach(docSnap => {
      const data = docSnap.data() || {};
      const uid = (data.user_id || docSnap.id || "").toString().trim();
      const uname = (data.name || data.user_name || data.display_name || uid).toString().trim();
      if (uid) userMap.set(uid, uname);
    });
  } catch (err) {
    console.warn("⚠️ โหลดรายชื่อจาก Collection users ไม่สำเร็จ:", err);
  }

  // เรียงตามชื่อผู้ใช้งานภาษาไทย/อังกฤษ
  const sortedUsers = Array.from(userMap.entries()).sort((a, b) => a[1].localeCompare(b[1], "th"));

  let optionsHtml = `<option value="">-- ผู้ใช้งานทั้งหมด --</option>`;
  sortedUsers.forEach(([uid, uname]) => {
    optionsHtml += `<option value="${escapeHtml(uid)}">${escapeHtml(uname)}</option>`;
  });

  selectEl.innerHTML = optionsHtml;
}

// ============================================================================
// 🔍 3. ค้นหาและแสดงผล Audit Logs จาก Firestore (getAuditLogsDev)
// ============================================================================
async function searchAuditLogs() {
  if (isSearchingLogs) return;

  const searchUser = document.getElementById('searchUser')?.value || "";
  const searchDate = document.getElementById('searchDate')?.value || "";
  const tbody = document.getElementById('auditLogTableBody');
  const btn = document.getElementById('btnSearchLogs');
  const originalBtnHtml = btn ? btn.innerHTML : "";

  isSearchingLogs = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span>`;
  }
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="2" class="text-center py-4">
          <div class="spinner-border text-primary" role="status"></div>
          <div class="mt-2 text-muted">กำลังค้นหาข้อมูล...</div>
        </td>
      </tr>`;
  }

  try {
    const logs = await getAuditLogsDev(searchUser, searchDate);

    // เติมรายชื่อผู้ใช้งานที่พบใน Log เข้า Dropdown เผื่อกรณีมีบัญชีที่ไม่อยู่ใน Collection users
    syncDropdownWithLogs(logs);

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="text-center text-danger py-4">❌ ไม่พบข้อมูลที่ตรงกับเงื่อนไข</td></tr>';
      return;
    }

    let html = '';
    logs.forEach(item => {
      const formattedTime = formatThaiDateTime(item.timestamp);
      const badgeClass = getActionBadgeClass(item.action);

      html += `
        <tr>
          <td class="fw-bold text-secondary small">
            <div>${escapeHtml(formattedTime)}</div>
            <div class="text-muted fw-normal" style="font-size: 11px;">${escapeHtml(item.timestamp)}</div>
          </td>
          <td>
            <span class="badge ${badgeClass} mb-1">${escapeHtml(item.action || 'ACTION')}</span>
            <div class="text-dark">${escapeHtml(item.details || '-')}</div>
            <small class="text-muted">👤 บัญชี LINE: <b>${escapeHtml(item.user_name || '-')}</b></small>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  } catch (err) {
    console.error("❌ searchAuditLogs Error:", err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="2" class="text-center text-danger py-4">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
    }
  } finally {
    isSearchingLogs = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml;
    }
  }
}

async function getAuditLogsDev(searchUserId, searchDate) {
  try {
    const logsRef = collection(db, "audit_logs");
    let q;

    // หากเลือกรายชื่อผู้ใช้งาน ให้กรองด้วย where("user_id", "==", ...) เพื่อไม่ต้องใช้ Composite Index
if (searchUserId && searchUserId.trim() !== "") {
      q = query(
        logsRef,
        where("user_id", "==", searchUserId.trim()),
        limit(500)
      );
    } else {
      q = query(
        logsRef,
        orderBy("timestamp", "desc"),
        limit(500)
      );
    }

    const snap = await getDocs(q);
    const cleanDate = searchDate ? searchDate.trim() : "";
    const results = [];

    snap.forEach(docSnap => {
      const fields = docSnap.data() || {};
      const userId = (fields.user_id || "").toString();
      const userName = (fields.user_name || "").toString();
      const timestamp = (fields.timestamp || "").toString();
      const action = (fields.action || "").toString();
      const details = (fields.details || "").toString();

      // แปลง ISO Timestamp ให้เป็นวันที่เวลาไทย (GMT+7: YYYY-MM-DD)
      let docDateStr = "";
      if (timestamp) {
        docDateStr = toBangkokDateStr(timestamp);
      }

      const matchDate = cleanDate ? (docDateStr === cleanDate) : true;
      if (matchDate) {
        results.push({
          timestamp,
          action,
          details,
          user_name: userName,
          user_id: userId
        });
      }
    });

    // เรียงลำดับจากเวลาล่าสุดไปเก่าสุด
    return results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (e) {
    console.error("❌ Exception ใน getAuditLogsDev:", e);
    return [];
  }
}

function resetAuditFilters() {
  const userEl = document.getElementById("searchUser");
  const dateEl = document.getElementById("searchDate");
  if (userEl) userEl.value = "";
  if (dateEl) dateEl.value = "";
  searchAuditLogs();
}

function syncDropdownWithLogs(logs) {
  const selectEl = document.getElementById("searchUser");
  if (!selectEl || !Array.isArray(logs)) return;

  const existingValues = new Set(Array.from(selectEl.options).map(o => o.value));
  logs.forEach(log => {
    if (log.user_id && !existingValues.has(log.user_id)) {
      existingValues.add(log.user_id);
      const opt = document.createElement("option");
      opt.value = log.user_id;
      opt.textContent = log.user_name || log.user_id;
      selectEl.appendChild(opt);
    }
  });
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function toBangkokDateStr(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.substring(0, 10);
    // แปลงเป็น YYYY-MM-DD ตามเวลา Asia/Bangkok (GMT+7)
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  } catch (e) {
    return isoStr.substring(0, 10);
  }
}

function formatThaiDateTime(isoStr) {
  if (!isoStr) return "-";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(d);
  } catch (e) {
    return isoStr;
  }
}

function getActionBadgeClass(action) {
  const act = (action || "").toUpperCase();
  if (act.includes("DELETE") || act.includes("REMOVE")) return "bg-danger text-white";
  if (act.includes("SAVE") || act.includes("VERIFY") || act.includes("CREATE")) return "bg-success text-white";
  if (act.includes("LOGIN") || act.includes("LOGOUT")) return "bg-secondary text-white";
  return "bg-info text-dark";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window
window.searchAuditLogs = searchAuditLogs;
window.resetAuditFilters = resetAuditFilters;