// public/js/fin-report.js
import { db, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  getDocs 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let isFetchingFinancial = false;

const STORE_MAP = {
  "Atom": "Atom",
  "Atom Beach": "Atom_Beach",
  "Good Time": "Good_Time",
  "Paradise": "Paradise",
  "Tiger King Bar & Bistro": "Tiger_King_Bar_&_Bistro"
};

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("FinancialReportSection")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าช่วงวันที่เริ่มต้น: วันที่ 1 ของเดือนปัจจุบัน ถึง วันที่ปัจจุบัน
  const now = new Date();
  const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];
  const firstDayOfMonth = localToday.slice(0, 8) + "01";

  const startEl = document.getElementById("finStartDate");
  const endEl = document.getElementById("finEndDate");
  if (startEl && !startEl.value) startEl.value = firstDayOfMonth;
  if (endEl && !endEl.value) endEl.value = localToday;

  await fetchFinancialData();
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้ารายงานสรุปผลประกอบการ");
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
// 📊 2. ดึงข้อมูลรายรับ (Income) และรายจ่าย (OCR / Cashout) พร้อมกัน
// ============================================================================
async function fetchFinancialData() {
  if (isFetchingFinancial) return;

  const start = document.getElementById('finStartDate').value;
  const end = document.getElementById('finEndDate').value;
  const store = document.getElementById('finStoreSelect').value;

  if (!start || !end) {
    return Swal.fire("แจ้งเตือน", "กรุณาระบุช่วงวันที่", "warning");
  }
  if (start > end) {
    return Swal.fire("แจ้งเตือน", "วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด", "warning");
  }

  const btn = document.getElementById("btnProcessFin");
  const tbody = document.getElementById("finSummaryTableBody");
  const originalBtnHtml = btn ? btn.innerHTML : "";

  isFetchingFinancial = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังประมวลผล...`;
  }
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-muted py-5">
          <div class="spinner-border text-success spinner-border-sm me-2"></div>กำลังประมวลผลรายรับ-รายจ่าย...
        </td>
      </tr>`;
  }

  try {
    // ดึงข้อมูลทั้ง 2 แหล่งพร้อมกันด้วย Promise.all
    const [incomeData, ocrData] = await Promise.all([
      getSummaryReport(start, end, store),
      getOcrExpenseReport(start, end, store)
    ]);

    renderFinancialOverview(incomeData, ocrData);
  } catch (err) {
    console.error("❌ Financial Data Error:", err);
    Swal.fire("ข้อผิดพลาด", "ไม่สามารถดึงข้อมูลได้: " + err.message, "error");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger py-4">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
    }
  } finally {
    isFetchingFinancial = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml;
    }
  }
}

// ดึงรายได้จาก income/{storeId}/daily_records
async function getSummaryReport(start, end, store) {
  let targetStores = [];
  if (store === "ทั้งหมด") {
    targetStores = Object.values(STORE_MAP);
  } else {
    const mappedStore = STORE_MAP[store.trim()];
    targetStores = mappedStore ? [mappedStore] : [store.trim().replace(/\s+/g, '_')];
  }

  const storePromises = targetStores.map(async (storeId) => {
    const colRef = collection(db, "income", storeId, "daily_records");
    const snap = await getDocs(colRef);
    return snap.docs.map(docSnap => ({
      storeId,
      docId: docSnap.id,
      fields: docSnap.data() || {}
    }));
  });

  const nestedDocs = await Promise.all(storePromises);
  const allDocuments = nestedDocs.flat();

  const getNum = (val) => {
    if (val === undefined || val === null || val === "") return 0;
    const parsed = Number(val);
    return isNaN(parsed) ? 0 : parsed;
  };

  return allDocuments
    .map(entry => {
      const docId = entry.docId; // YYYY-MM-DD
      const shopDisplay = entry.storeId.replace(/_/g, ' ');
      const f = entry.fields;

      let totalCollected = 0;
      if (Array.isArray(f.records) && f.records.length > 0 && f.records[0]) {
        const rf = f.records[0];
        totalCollected = getNum(rf["Total Amount Collected"] ?? rf.TotalAmountCollected);
      } else {
        totalCollected = getNum(f.total_amount);
      }

      return {
        date: docId,
        store: shopDisplay,
        total: totalCollected
      };
    })
    .filter(item => item.date >= start && item.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ดึงรายจ่าย OCR / Cashout จาก cashout/{storeId}/days/{dateStr}/bills
async function getOcrExpenseReport(start, end, store) {
  let targetStores = [];
  if (store === "ทั้งหมด") {
    targetStores = Object.values(STORE_MAP);
  } else {
    const mappedStore = STORE_MAP[store.trim()];
    targetStores = mappedStore ? [mappedStore] : [store.trim().replace(/\s+/g, '_')];
  }

  // แตกช่วงวันที่ start ถึง end เป็น YYYY-MM-DD
  const dateList = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const currentDate = new Date(sy, sm - 1, sd);
  const endDate = new Date(ey, em - 1, ed);

  while (currentDate <= endDate) {
    const yyyy = currentDate.getFullYear();
    const mm = String(currentDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentDate.getDate()).padStart(2, '0');
    dateList.push(`${yyyy}-${mm}-${dd}`);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const fetchTasks = [];
  dateList.forEach(dateStr => {
    targetStores.forEach(storeId => {
      fetchTasks.push(async () => {
        try {
          const billsColRef = collection(db, "cashout", storeId, "days", dateStr, "bills");
          const snap = await getDocs(billsColRef);
          const rows = [];

          snap.forEach(docSnap => {
            const bf = docSnap.data() || {};
            const amount = parseFloat(bf.bill_total) || parseFloat(bf.total_amount) || 0;
            const shopRaw = (bf.shop_bill || storeId).toString().replace(/_/g, ' ').trim();

            rows.push({
              date: dateStr,
              shop: shopRaw,
              money: amount
            });
          });

          return rows;
        } catch (err) {
          return [];
        }
      });
    });
  });

  const nestedRows = await Promise.all(fetchTasks.map(fn => fn()));
  const rows = nestedRows.flat();
  const total = rows.reduce((sum, r) => sum + r.money, 0);

  return {
    total,
    count: rows.length,
    rows
  };
}

// ============================================================================
// 🎨 3. แสดงผลการ์ดสรุปและตารางเปรียบเทียบ (renderFinancialOverview)
// ============================================================================
function renderFinancialOverview(incomeData, ocrData) {
  const displayInc = document.getElementById('finTotalIncomeDisplay');
  const displayOcr = document.getElementById('finTotalOCRDisplay');
  const displayExpPercent = document.getElementById('finExpensePercentDisplay');
  const displayProfit = document.getElementById('finNetProfitDisplay');
  const displayProfitPercent = document.getElementById('finProfitPercentDisplay');
  const tbody = document.getElementById('finSummaryTableBody');

  let totalInc = 0;
  let totalOcr = ocrData.total || 0;
  let rowsHtml = "";

  // 1. เตรียม Map รายจ่าย OCR และเก็บรายการคีย์ทั้งหมด (ทั้งฝั่งรายรับและรายจ่าย)
  const ocrMap = {};
  const combinedKeysMap = new Map(); // key -> { date, storeDisplay, inc, exp }

  if (ocrData.rows) {
    ocrData.rows.forEach(r => {
      const storeClean = String(r.shop || "").replace(/_/g, ' ').trim();
      const key = `${r.date}_${storeClean.toLowerCase()}`;
      ocrMap[key] = (ocrMap[key] || 0) + r.money;

      if (!combinedKeysMap.has(key)) {
        combinedKeysMap.set(key, {
          date: r.date,
          store: storeClean,
          inc: 0,
          exp: 0
        });
      }
      combinedKeysMap.get(key).exp += r.money;
    });
  }

  if (incomeData && incomeData.length > 0) {
    incomeData.forEach(item => {
      const inc = Number(item.total) || 0;
      const storeClean = String(item.store || "").replace(/_/g, ' ').trim();
      const key = `${item.date}_${storeClean.toLowerCase()}`;

      totalInc += inc;

      if (!combinedKeysMap.has(key)) {
        combinedKeysMap.set(key, {
          date: item.date,
          store: storeClean,
          inc: 0,
          exp: ocrMap[key] || 0
        });
      }
      combinedKeysMap.get(key).inc += inc;
    });
  }

  // 2. เรียงตามวันที่และวาดตาราง
  const sortedRows = Array.from(combinedKeysMap.values()).sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    return dateCmp !== 0 ? dateCmp : a.store.localeCompare(b.store);
  });

  if (sortedRows.length > 0) {
    sortedRows.forEach(row => {
      rowsHtml += `
        <tr>
          <td>${escapeHtml(row.date)}</td>
          <td>${escapeHtml(row.store)}</td>
          <td class="text-end text-primary fw-bold">${row.inc.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td class="text-end text-danger">${row.exp.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>
      `;
    });
  } else {
    rowsHtml = '<tr><td colspan="4" class="text-center py-5 text-muted">ไม่พบข้อมูลในช่วงเวลาดังกล่าว</td></tr>';
  }

  // 3. อัปเดต Dashboard ด้านบน
  if (displayInc) displayInc.innerText = totalInc.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (displayOcr) displayOcr.innerText = totalOcr.toLocaleString(undefined, { minimumFractionDigits: 2 });
  
  const netProfit = totalInc - totalOcr;
  if (displayProfit) displayProfit.innerText = netProfit.toLocaleString(undefined, { minimumFractionDigits: 2 });

  // 4. คำนวณเปอร์เซ็นต์สรุป
  if (totalInc > 0) {
    const expTotalPercent = (totalOcr / totalInc) * 100;
    const profitTotalPercent = (netProfit / totalInc) * 100;
    
    if (displayExpPercent) displayExpPercent.innerHTML = `ต้นทุนเป็น <strong>${expTotalPercent.toFixed(2)}%</strong> ของรายได้`;
    if (displayProfitPercent) displayProfitPercent.innerHTML = `กำไรสุทธิ <strong>${profitTotalPercent.toFixed(2)}%</strong> ของรายได้`;
  } else {
    if (displayExpPercent) displayExpPercent.innerText = "0%";
    if (displayProfitPercent) displayProfitPercent.innerText = "0%";
  }

  if (tbody) tbody.innerHTML = rowsHtml;
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window
window.fetchFinancialData = fetchFinancialData;