// public/js/sum-cashout.js
import { db, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  getDocs 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let isProcessing = false;

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
  if (!verifyPageAccess("ExpenseSummarySection")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าช่วงวันที่เริ่มต้น: วันที่ 1 ของเดือนปัจจุบัน ถึง วันที่ปัจจุบัน
  const now = new Date();
  const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];
  const firstDayOfMonth = localToday.slice(0, 8) + "01";

  const startEl = document.getElementById("dateStart");
  const endEl = document.getElementById("dateEnd");
  if (startEl && !startEl.value) startEl.value = firstDayOfMonth;
  if (endEl && !endEl.value) endEl.value = localToday;

  await processFirestoreExpenseData();
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้ารายงานรายจ่าย (Cashout)");
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
// 📊 2. ประมวลผลและดึงข้อมูล Cash Out รายวันจาก Firestore (Multi-Path Mode)
// ============================================================================
async function processFirestoreExpenseData() {
  if (isProcessing) return;

  const btn = document.getElementById('btnProcess');
  const dateStart = document.getElementById('dateStart').value;
  const dateEnd = document.getElementById('dateEnd').value;
  const shop = document.getElementById('shopFilter').value;
  const category = document.getElementById('categoryFilter').value;
  const supplier = document.getElementById('supplierFilter').value;

  if (!dateStart || !dateEnd) {
    alert("กรุณาเลือกวันที่ให้ครบถ้วน");
    return;
  }

  if (dateStart > dateEnd) {
    alert("วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด");
    return;
  }

  isProcessing = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังประมวลผล...';
  
  document.getElementById('totalCashOut').innerText = "---";
  document.getElementById('tableCashOut').innerHTML = `<div class="text-center py-5"><div class="spinner-grow text-danger"></div></div>`;

  try {
    const result = await getCashOutReport(dateStart, dateEnd, shop, supplier, category);

    document.getElementById('totalCashOut').innerText = result.total.toLocaleString(undefined, {
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2
    });
    
    const supplierSelect = document.getElementById('supplierFilter');
    const categorySelect = document.getElementById('categoryFilter');
    const currentSupplierVal = supplierSelect.value; 
    const currentCategoryVal = categorySelect.value;
    const supplierSet = new Set();
    const categorySet = new Set();
    
    let html = '<table class="table table-sm table-hover table-striped mb-0 align-middle">';
    html += `
      <thead class="table-dark sticky-top">
        <tr>
          <th>วันที่บิล</th>
          <th>ร้าน (Shop)</th>
          <th>ประเภทค่าใช้จ่าย</th>
          <th>Supplier</th>
          <th class="text-end">ยอดเงินรวม</th>
        </tr>
      </thead>
      <tbody>
    `;
    
    if (!result.rows || result.rows.length === 0) {
      html += '<tr><td colspan="5" class="text-center py-4 text-muted">ไม่พบข้อมูล Cash Out ตามเงื่อนไขที่เลือก</td></tr>';
    } else {
      result.rows.forEach(row => {
        if (row.supplier) supplierSet.add(row.supplier.toString().trim());
        if (row.category) categorySet.add(row.category.toString().trim());

        html += `<tr>
          <td class="small">${escapeHtml(row.date)}</td>
          <td><span class="badge bg-secondary">${escapeHtml(getDisplayShopName(row.shop_bill))}</span></td>
          <td><span class="badge bg-info text-dark">${escapeHtml(row.category)}</span></td>
          <td><strong>${escapeHtml(row.supplier)}</strong></td>
          <td class="text-end text-danger fw-bold">${row.bill_total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>`;
      });
    }
    html += '</tbody></table>';
    document.getElementById('tableCashOut').innerHTML = html;

    // อัปเดต Dropdown Supplier
    let supplierHtml = '<option value="All">-- ทุก Supplier --</option>';
    Array.from(supplierSet).sort((a, b) => a.localeCompare(b, 'th')).forEach(supName => {
      supplierHtml += `<option value="${escapeHtml(supName)}">${escapeHtml(supName)}</option>`;
    });
    supplierSelect.innerHTML = supplierHtml;
    if (supplierSet.has(currentSupplierVal)) supplierSelect.value = currentSupplierVal;

    // อัปเดต Dropdown ประเภทค่าใช้จ่าย
    let categoryHtml = '<option value="All">-- ทุกประเภท --</option>';
    Array.from(categorySet).sort((a, b) => a.localeCompare(b, 'th')).forEach(catName => {
      categoryHtml += `<option value="${escapeHtml(catName)}">${escapeHtml(catName)}</option>`;
    });
    categorySelect.innerHTML = categoryHtml;
    if (categorySet.has(currentCategoryVal)) categorySelect.value = currentCategoryVal;

  } catch (err) {
    console.error("❌ Firebase Error:", err);
    document.getElementById('tableCashOut').innerHTML = `<p class="text-center text-danger py-4">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</p>`;
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search me-1"></i> ประมวลผล';
  }
}

async function getCashOutReport(start, end, shopFilter, supplierFilter, categoryFilter) {
  let shopsToFetch = [];
  if (!shopFilter || shopFilter === "All") {
    shopsToFetch = TARGET_STORES;
  } else {
    shopsToFetch = [shopFilter];
  }

  // แตกช่วงวันที่ start ถึง end เป็น Array ของ YYYY-MM-DD (ใช้วันที่แบบ Local ป้องกัน UTC เลื่อนวัน)
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

  // สร้าง Task ดึงข้อมูลทุกวันและทุกสาขาเป้าหมายพร้อมกันแบบ Parallel
  const fetchTasks = [];
  dateList.forEach(dateStr => {
    shopsToFetch.forEach(shop => {
      fetchTasks.push(async () => {
        try {
          const billsColRef = collection(db, "cashout", shop, "days", dateStr, "bills");
          const snap = await getDocs(billsColRef);
          const rows = [];

          snap.forEach(docSnap => {
            const billFields = docSnap.data() || {};
            const itemDate = dateStr;
            const itemShop = billFields.shop_bill || shop;
            const itemSupplier = billFields.supplier ? billFields.supplier.toString().trim() : "บิลเงินสด";
            const itemCategory = billFields.category || "ไม่ระบุประเภท";
            const itemAmount = parseFloat(billFields.bill_total) || parseFloat(billFields.total_amount) || 0;

            if (supplierFilter !== "All" && itemSupplier !== supplierFilter.toString().trim()) return;
            if (categoryFilter !== "All" && itemCategory !== categoryFilter.toString().trim()) return;

            rows.push({
              date:       itemDate,
              shop_bill:  itemShop,
              category:   itemCategory,
              supplier:   itemSupplier,
              bill_total: itemAmount
            });
          });

          return rows;
        } catch (err) {
          console.warn(`⚠️ ข้ามพิกัด cashout/${shop}/days/${dateStr}/bills:`, err.message);
          return [];
        }
      });
    });
  });

  const nestedRows = await Promise.all(fetchTasks.map(fn => fn()));
  const reportRows = nestedRows.flat().sort((a, b) => a.date.localeCompare(b.date));
  const grandTotal = reportRows.reduce((sum, r) => sum + r.bill_total, 0);

  return {
    total: grandTotal,
    rows: reportRows
  };
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
    'Tiger_King_Bar_&_Bistro': 'Tiger King Bar & Bistro',
    'office':                  'Office',
    'Office':                  'Office'
  };
  return displayMap[shopClean] || shopClean;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window
window.processFirestoreExpenseData = processFirestoreExpenseData;