// public/js/audit-cashout.js
import { db, insertAuditLog } from "../../js/firestore.js";
import { 
  collection, 
  getDocs 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let isAuditing = false;

const TARGET_STORES = [
  "Atom",
  "Atom_Beach",
  "Good_Time",
  "Tiger_King_Bar_&_Bistro",
  "Paradise"
];

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("AuditCashoutSection")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าเดือนเริ่มต้นเป็นเดือนปัจจุบัน (YYYY-MM)
  const monthInput = document.getElementById("auditFilterMonth");
  if (monthInput && !monthInput.value) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    monthInput.value = `${yyyy}-${mm}`;
  }

  await loadCashoutAudit();
});

function verifyPageAccess(requiredOption) {
  const rawUser = sessionStorage.getItem("atom_line_user");
  if (!rawUser) {
    window.location.href = "../login.html";
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้า Audit Cashout");
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
    window.location.href = "../login.html";
    return false;
  }
}

async function handleLogout() {
  if (!confirm("ต้องการออกจากระบบใช่หรือไม่?")) return;
  if (window.currentUser) {
    await insertAuditLog("LOGOUT", "ผู้ใช้งานกดออกจากระบบ", window.currentUser);
  }
  sessionStorage.removeItem("atom_line_user");
  window.location.href = "../login.html";
}

// ============================================================================
// 📊 2. โหลดและประมวลผลข้อมูล Audit Cashout (checkCashoutAuditData)
// ============================================================================
async function loadCashoutAudit() {
  if (isAuditing) return;

  const fMonth = document.getElementById('auditFilterMonth')?.value || '';
  const fShop = document.getElementById('auditFilterShop')?.value || 'All';
  const fStatus = document.getElementById('auditFilterStatus')?.value || 'ALL';

  const btn = document.getElementById("btnAuditSearch");
  const tbody = document.getElementById("auditTableBody");
  const originalBtnHtml = btn ? btn.innerHTML : "";

  isAuditing = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังตรวจสอบ...`;
  }
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-5 text-muted">
          <div class="spinner-border text-primary spinner-border-sm me-2"></div>กำลังตรวจสอบข้อมูล Cash Out...
        </td>
      </tr>`;
  }

  try {
    const response = await checkCashoutAuditData({
      month: fMonth,
      shop: fShop,
      statusFilter: fStatus,
      hideNoData: true
    });

    renderAuditSummary(response.summary);
    renderAuditTable(response.items);
  } catch (err) {
    console.error("❌ Audit Error:", err);
    showToast("เกิดข้อผิดพลาด: " + err.message, "danger");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-danger">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
    }
  } finally {
    isAuditing = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml;
    }
  }
}

async function checkCashoutAuditData(filterObj = {}) {
  // 1. กำหนดเดือนที่ต้องการตรวจสอบ (YYYY-MM)
  let targetMonth = filterObj.month;
  if (!targetMonth) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    targetMonth = `${yyyy}-${mm}`;
  }

  const [yearStr, monthStr] = targetMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const daysInMonth = new Date(year, month, 0).getDate();

  const dateKeys = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2, '0');
    dateKeys.push(`${targetMonth}-${dd}`);
  }

  // 2. ร้านค้าที่ต้องการดึงข้อมูล
  let shopsToFetch = [];
  const isAllShops = !filterObj.shop || filterObj.shop === "All" || filterObj.shop === "" || filterObj.shop === "-- ทุกร้าน --";
  if (isAllShops) {
    shopsToFetch = TARGET_STORES;
  } else {
    shopsToFetch = [getUnifiedShopName(filterObj.shop)];
  }

  const cashoutParentMap = {}; // "Atom/days/2026-11-14" -> { parentBillTotal, status, url }
  const incomeDataMap = {};    // "Atom/daily_records/2026-11-14" -> number
  const billTotalMap = {};     // "Atom/days/2026-11-14" -> number

  // 3. ดึงคอลเลกชัน cashout/{shop}/days และ income/{shop}/daily_records ของทุกร้านพร้อมกัน
  await Promise.all(
    shopsToFetch.map(async (shop) => {
      const [daysSnap, incomeSnap] = await Promise.all([
        getDocs(collection(db, "cashout", shop, "days")).catch(() => null),
        getDocs(collection(db, "income", shop, "daily_records")).catch(() => null)
      ]);

      if (daysSnap) {
        daysSnap.forEach(docSnap => {
          const dateId = docSnap.id;
          if (dateId.startsWith(targetMonth)) {
            const fields = docSnap.data() || {};
            cashoutParentMap[`${shop}/days/${dateId}`] = {
              parentBillTotal: Number(fields.bill_total || fields.total_amount || 0),
              status: fields.status || "pending",
              url: fields.folder_url || fields.url || ""
            };
          }
        });
      }

      if (incomeSnap) {
        incomeSnap.forEach(docSnap => {
          const dateId = docSnap.id;
          if (dateId.startsWith(targetMonth)) {
            const fields = docSnap.data() || {};
            incomeDataMap[`${shop}/daily_records/${dateId}`] = parseFloat(fields.cash_out) || 0;
          }
        });
      }
    })
  );

  // 4. ดึงยอดบิลย่อยจาก Subcollection "bills" ของทุกวันในเดือนแบบขนาน (รองรับทั้งที่มีและไม่มีเอกสารแม่)
  const billFetchTasks = [];
  shopsToFetch.forEach(shop => {
    dateKeys.forEach(dateKey => {
      const fullPathId = `${shop}/days/${dateKey}`;
      billFetchTasks.push(async () => {
        let subBillTotal = 0;
        try {
          const billsSnap = await getDocs(collection(db, "cashout", shop, "days", dateKey, "bills"));
          if (billsSnap && !billsSnap.empty) {
            billsSnap.forEach(bDoc => {
              const bf = bDoc.data() || {};
              subBillTotal += (Number(bf.bill_total) || Number(bf.total_amount) || 0);
            });
          }
        } catch (err) {
          // ข้ามกรณีไม่มี subcollection บิล
        }
        const parentTotal = cashoutParentMap[fullPathId]?.parentBillTotal || 0;
        billTotalMap[fullPathId] = subBillTotal > 0 ? subBillTotal : parentTotal;
      });
    });
  });

  await Promise.all(billFetchTasks.map(fn => fn()));

  // 5. ประมวลผลและจัดหมวดหมู่การตรวจสอบ (Audit Logic)
  const auditResults = [];
  const summary = { match: 0, mismatch: 0, pending: 0, noData: 0 };

  shopsToFetch.forEach(shop => {
    dateKeys.forEach(dateKey => {
      const fullPathId = `${shop}/days/${dateKey}`;
      const iPath = `${shop}/daily_records/${dateKey}`;

      const billTotal = billTotalMap[fullPathId] || 0;
      const enteredCashOut = incomeDataMap[iPath] || 0;
      const diff = Math.abs(billTotal - enteredCashOut);

      let auditStatus = "MATCH";
      let statusText = "ตรงกัน";

      if (billTotal === 0 && enteredCashOut === 0) {
        auditStatus = "NO_DATA";
        statusText = "ไม่มีข้อมูล";
        summary.noData++;
      } else if (billTotal > 0 && enteredCashOut === 0) {
        auditStatus = "PENDING_INPUT";
        statusText = "ยังไม่คีย์ในระบบ";
        summary.pending++;
      } else if (diff > 0.01) {
        auditStatus = "MISMATCH";
        statusText = "ยอดไม่ตรงกัน";
        summary.mismatch++;
      } else {
        auditStatus = "MATCH";
        statusText = "ตรงกัน";
        summary.match++;
      }

      if (filterObj.hideNoData && auditStatus === "NO_DATA") {
        return;
      }

      if (!filterObj.statusFilter || filterObj.statusFilter === "ALL" || filterObj.statusFilter === auditStatus) {
        auditResults.push({
          docId: fullPathId,
          shop: shop,
          dateKey: dateKey,
          billTotalAmount: billTotal,
          cashOutAmount: enteredCashOut,
          diffAmount: diff,
          auditStatus: auditStatus,
          statusText: statusText,
          url: cashoutParentMap[fullPathId]?.url || ""
        });
      }
    });
  });

  // เรียงตามวันที่จากน้อยไปมาก และตามชื่อร้าน
  auditResults.sort((a, b) => {
    const dCmp = a.dateKey.localeCompare(b.dateKey);
    return dCmp !== 0 ? dCmp : a.shop.localeCompare(b.shop);
  });

  return {
    month: targetMonth,
    summary,
    items: auditResults
  };
}

// ============================================================================
// 🎨 3. แสดงผลการ์ดสรุปและตารางตรวจสอบ (renderAuditSummary / renderAuditTable)
// ============================================================================
function renderAuditSummary(summary) {
  const container = document.getElementById('auditSummaryCards');
  if (container) container.style.display = 'flex';

  if (!summary) return;

  const elMismatch = document.getElementById('sumMismatch');
  const elPending = document.getElementById('sumPending');
  const elMatch = document.getElementById('sumMatch');

  if (elMismatch) elMismatch.innerText = (summary.mismatch || 0).toLocaleString();
  if (elPending) elPending.innerText = (summary.pending || 0).toLocaleString();
  if (elMatch) elMatch.innerText = (summary.match || 0).toLocaleString();
}

function renderAuditTable(items) {
  const tbody = document.getElementById('auditTableBody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-5 text-muted">
          <i class="bi bi-inbox fs-2 d-block mb-2"></i>
          ไม่พบรายการที่ตรงตามเงื่อนไข
        </td>
      </tr>`;
    return;
  }

  let html = '';
  items.forEach(item => {
    let rowClass = '';
    if (item.auditStatus === 'MISMATCH') {
      rowClass = 'table-danger';
    } else if (item.auditStatus === 'PENDING_INPUT') {
      rowClass = 'table-warning';
    }

    const billAmountStr = item.billTotalAmount > 0 
      ? `฿${item.billTotalAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : '-';
    const cashAmountStr = item.cashOutAmount > 0 
      ? `฿${item.cashOutAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : '-';
    const diffStr = item.diffAmount > 0.01 
      ? `฿${item.diffAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : '-';

    html += `
      <tr class="${rowClass}">
        <td class="fw-semibold">${escapeHtml(item.dateKey)}</td>
        <td><span class="fw-bold">${escapeHtml(getDisplayShopName(item.shop))}</span></td>
        <td class="text-end fw-bold text-primary">${billAmountStr}</td>
        <td class="text-end">${cashAmountStr}</td>
        <td class="text-end fw-bold ${item.diffAmount > 0.01 ? 'text-danger' : 'text-muted'}">${diffStr}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function getDisplayShopName(rawShop) {
  if (!rawShop) return "-";
  const shopClean = rawShop.toString().trim();
  const displayMap = {
    'Atom_Beach':              'Atom Beach',
    'Good_Time':               'Good Time',
    'Tiger_King_Bar_&_Bistro': 'Tiger King Bar & Bistro'
  };
  return displayMap[shopClean] || shopClean;
}

function getUnifiedShopName(rawShop) {
  if (!rawShop) return "Atom";
  const lookupKey = rawShop.toString().toLowerCase().replace(/[\s_\-]+/g, '').trim();
  const shopMap = {
    'atom':                'Atom',
    'atombeach':           'Atom_Beach',
    'goodtime':            'Good_Time',
    'paradise':            'Paradise',
    'tiger':               'Tiger_King_Bar_&_Bistro',
    'tigerking':           'Tiger_King_Bar_&_Bistro',
    'tigerkingbarbistro':  'Tiger_King_Bar_&_Bistro',
    'tigerkingbar&bistro': 'Tiger_King_Bar_&_Bistro'
  };
  return shopMap[lookupKey] || rawShop.trim();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type = "primary") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toastEl = document.createElement("div");
  toastEl.className = `toast align-items-center text-bg-${type} border-0 show mb-2`;
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 3500);
}

// ผูกฟังก์ชันเข้า window
window.loadCashoutAudit = loadCashoutAudit;