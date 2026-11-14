// public/js/sum-income.js
import { db, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  getDocs 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let mySalesChart = null;
let isFetchingSummary = false;

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
  if (!verifyPageAccess("SummarySection")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าช่วงวันที่เริ่มต้น: วันที่ 1 ของเดือนปัจจุบัน ถึง วันที่ปัจจุบัน
  const now = new Date();
  const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];
  const firstDayOfMonth = localToday.slice(0, 8) + "01";

  const startEl = document.getElementById("sumStartDate");
  const endEl = document.getElementById("sumEndDate");
  if (startEl && !startEl.value) startEl.value = firstDayOfMonth;
  if (endEl && !endEl.value) endEl.value = localToday;

  await fetchSummary();
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้ารายงานสรุปยอดขาย");
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
// 📊 2. ค้นหาและดึงข้อมูลสรุปยอดขายจาก Firestore (getSummaryReport)
// ============================================================================
async function fetchSummary() {
  if (isFetchingSummary) return;

  const start = document.getElementById('sumStartDate').value;
  const end = document.getElementById('sumEndDate').value;
  const store = document.getElementById('sumStoreSelect').value;

  if (!start || !end) {
    return Swal.fire("แจ้งเตือน", "กรุณาระบุช่วงวันที่", "warning");
  }

  const btnSearch = document.getElementById("btnSearchSummary");
  const tbody = document.getElementById('summaryTableBody');
  const originalBtnHtml = btnSearch ? btnSearch.innerHTML : "";

  isFetchingSummary = true;
  if (btnSearch) {
    btnSearch.disabled = true;
    btnSearch.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังค้นหา...`;
  }
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="py-5 text-muted">
          <div class="spinner-border text-primary spinner-border-sm me-2"></div>กำลังประมวลผลข้อมูล...
        </td>
      </tr>`;
  }

  try {
    const data = await getSummaryReport(start, end, store);
    renderSummaryTable(data);
  } catch (err) {
    console.error("❌ Search error:", err);
    Swal.fire("ข้อผิดพลาด", "ไม่สามารถดึงข้อมูลได้: " + err.message, "error");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-4 text-danger">ไม่สามารถดึงข้อมูลได้: ${escapeHtml(err.message)}</td></tr>`;
    }
  } finally {
    isFetchingSummary = false;
    if (btnSearch) {
      btnSearch.disabled = false;
      btnSearch.innerHTML = originalBtnHtml;
    }
  }
}

async function getSummaryReport(start, end, store) {
  let targetStores = [];
  if (store === "ทั้งหมด") {
    targetStores = Object.values(STORE_MAP);
  } else {
    const mappedStore = STORE_MAP[store.trim()];
    targetStores = mappedStore ? [mappedStore] : [store.trim().replace(/\s+/g, '_')];
  }

  // ดึงข้อมูลแบบขนานเฉพาะสาขาเป้าหมายเพื่อความรวดเร็ว
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

      let ochaSummary = {
        Cash: 0,
        VISA: 0,
        Mastercard: 0,
        "Bank Transfer": 0,
        Other: 0,
        "Total Amount Collected": 0
      };

      if (Array.isArray(f.records) && f.records.length > 0 && f.records[0]) {
        const rf = f.records[0];
        ochaSummary.Cash = getNum(rf.Cash);
        ochaSummary.VISA = getNum(rf.VISA);
        ochaSummary.Mastercard = getNum(rf.Mastercard);
        ochaSummary["Bank Transfer"] = getNum(rf["Bank Transfer"] ?? rf.BankTransfer);
        ochaSummary.Other = getNum(rf.Other);
        ochaSummary["Total Amount Collected"] = getNum(rf["Total Amount Collected"] ?? rf.TotalAmountCollected);
      } else {
        ochaSummary.Cash = getNum(f.cash);
        ochaSummary.VISA = getNum(f.visa);
        ochaSummary.Mastercard = getNum(f.mastercard);
        ochaSummary["Bank Transfer"] = getNum(f.bank_transfer);
        ochaSummary.Other = getNum(f.other_ocha);
        ochaSummary["Total Amount Collected"] = getNum(f.total_amount);
      }

      return {
        date:     docId,
        store:    shopDisplay,
        cash:     ochaSummary.Cash,
        visa:     ochaSummary.VISA,
        master:   ochaSummary.Mastercard,
        transfer: ochaSummary["Bank Transfer"],
        other:    ochaSummary.Other,
        total:    ochaSummary["Total Amount Collected"]
      };
    })
    .filter(item => item.date >= start && item.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================================
// 🎨 3. วาดการ์ดสรุปยอด ตาราง และกราฟ Chart.js
// ============================================================================
function renderSummaryTable(data) {
  const tbody = document.getElementById('summaryTableBody');
  const tfoot = document.getElementById('summaryTableFoot');
  const topSummary = document.getElementById('topSummaryCard');
  
  if (!tbody || !tfoot) return;
  
  tbody.innerHTML = "";
  if (topSummary) topSummary.innerHTML = ""; 
  
  if (!data || !Array.isArray(data) || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">ไม่พบข้อมูล</td></tr>';
    tfoot.innerHTML = "";
    if (mySalesChart) {
      mySalesChart.destroy();
      mySalesChart = null;
    }
    return;
  }

  let sums = { visa: 0, master: 0, transfer: 0, other: 0, cash: 0, total: 0 };
  let rowsHtml = "";

  data.forEach(item => {
    const v = Number(item.visa) || 0;
    const m = Number(item.master) || 0;
    const t = Number(item.transfer) || 0;
    const o = Number(item.other) || 0;
    const c = Number(item.cash) || 0;
    const tot = Number(item.total) || 0;

    sums.visa += v;
    sums.master += m;
    sums.transfer += t;
    sums.other += o;
    sums.cash += c;
    sums.total += tot;

    rowsHtml += `
      <tr>
        <td>${escapeHtml(item.date || '-')}</td>
        <td>${escapeHtml(item.store || '-')}</td>
        <td class="text-end">${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-end">${m.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-end">${t.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-end">${o.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-end">${c.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-end fw-bold text-primary">${tot.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;

  if (topSummary) {
    topSummary.innerHTML = `
      <div class="col-md-4 col-lg-2">
        <div class="p-2 border rounded bg-white text-center shadow-sm">
          <small class="text-muted fw-bold">รวม VISA</small>
          <div class="text-primary fw-bold">${sums.visa.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div class="col-md-4 col-lg-2">
        <div class="p-2 border rounded bg-white text-center shadow-sm">
          <small class="text-muted fw-bold">รวม Master</small>
          <div class="text-primary fw-bold">${sums.master.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div class="col-md-4 col-lg-2">
        <div class="p-2 border rounded bg-white text-center shadow-sm">
          <small class="text-muted fw-bold">รวม Transfer</small>
          <div class="text-primary fw-bold">${sums.transfer.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div class="col-md-4 col-lg-2">
        <div class="p-2 border rounded bg-white text-center shadow-sm">
          <small class="text-muted fw-bold">รวม Other</small>
          <div class="text-primary fw-bold">${sums.other.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div class="col-md-4 col-lg-2">
        <div class="p-2 border rounded bg-warning-subtle text-center shadow-sm">
          <small class="text-muted fw-bold">รวม Cash</small>
          <div class="text-danger fw-bold">${sums.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div class="col-md-12 col-lg-2">
        <div class="p-2 border rounded bg-primary text-white text-center shadow">
          <small class="fw-bold">ยอดรวมทั้งสิ้น (AA)</small>
          <div class="fs-5 fw-bold">${sums.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>
    `;
  }

  tfoot.innerHTML = `
    <tr class="table-dark">
      <td colspan="2" class="text-center">รวมทั้งสิ้น</td>
      <td class="text-end">${sums.visa.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td class="text-end">${sums.master.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td class="text-end">${sums.transfer.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td class="text-end">${sums.other.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td class="text-end">${sums.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td class="text-end text-warning">${sums.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
    </tr>
  `;

  renderChart(data);
}

function renderChart(data) {
  const chartEl = document.getElementById('salesChart');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  
  if (mySalesChart) {
    mySalesChart.destroy();
    mySalesChart = null;
  }
  if (!data || data.length === 0) return;

  const dates = [...new Set(data.map(item => item.date))].sort();
  const stores = [...new Set(data.map(item => item.store))];
  const colors = ['#003366', '#00a8cc', '#ff6b6b', '#51cf66', '#fcc419', '#ae3ec9', '#ff922b'];

  const datasets = stores.map((store, index) => {
    return {
      label: store,
      data: dates.map(date => {
        const record = data.find(d => d.date === date && d.store === store);
        return record ? Number(record.total) : 0;
      }),
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length] + '20',
      tension: 0.3,
      fill: false,
      borderWidth: 3,
      pointRadius: 4
    };
  });

  mySalesChart = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => v.toLocaleString() } }
      }
    }
  });
}

function printSummary() {
  const start = document.getElementById('sumStartDate').value;
  const end = document.getElementById('sumEndDate').value;
  const store = document.getElementById('sumStoreSelect').value;
  const printText = document.getElementById('printPeriodText');
  if (printText) {
    printText.innerText = `สาขา: ${store} | ระหว่างวันที่ ${start} ถึง ${end}`;
  }
  window.print();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window
window.fetchSummary = fetchSummary;
window.printSummary = printSummary;