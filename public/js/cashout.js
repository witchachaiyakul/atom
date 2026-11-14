// public/js/cashout.js
import { db, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let allCashouts = [];
let filteredCashouts = [];
let currentDayBillsData = [];
let currentActiveBillIndex = null;
let activeDocId = null;

// ตัวแปรควบคุมการซูม/ลาก/หมุนรูปภาพใน Modal
let imgZoomScale = 1;
let imgRotateDegree = 0;
let imgPanX = 0;
let imgPanY = 0;
let isDraggingImg = false;
let startDragX = 0;
let startDragY = 0;

const TARGET_STORES = [
  "Atom",
  "Atom_Beach",
  "Good_Time",
  "Paradise",
  "Tiger_King_Bar_&_Bistro"
];

// 📌 วัตถุศูนย์กลางการตั้งค่าคู่ค้า (Supplier Auto-Mapping Configuration)
const supplierCategoryMap = {
  "ใบส่งของชั่วคราว": "ค่าน้ำดื่มและน้ำแข็ง",
  "พี.พี.มารีน่าน้ำดื่ม": "ค่าน้ำดื่มและน้ำแข็ง",
  "อะลาดิน": "ค่าน้ำดื่มและน้ำแข็ง",
  "PP Princess Resort": "ค่าวัตถุดิบ",
  "ช่างโก้ ผักสด": "ค่าวัตถุดิบ",
  "ร้านวาสนาผลไม้": "ค่าวัตถุดิบ",
  "เจ้หมวย": "ค่าแก๊ส",
  "ขายส่ง": "ค่าวัตถุดิบ",
  "7-Eleven": "ค่าใช้จ่ายอื่นๆ",
  "CHAI SHOP": "ค่าเครื่องดื่ม",
  "เรือขนส่งสินค้า โชคปรีชา (ช่างโก้)": "ค่าขนส่ง",
  "แฮปปี้": "ค่าขนส่ง",
  "บริษัท ป้าสาวพีพี จำกัด": "ค่าเครื่องดื่ม",
  "แสงตะวันซีฟู๊ด": "ค่าวัตถุดิบ",
  "แสงตะวันซีฟู้ด": "ค่าวัตถุดิบ"
};

// 📌 รายการประเภทค่าใช้จ่ายหลักของระบบทั้งหมด สำหรับวนลูปสร้าง Dropdown
const cashoutCategories = [
  "ค่าวัตถุดิบ",
  "ค่าขนส่ง",
  "ค่าน้ำประปา",
  "ค่าน้ำดื่มและน้ำแข็ง",
  "ค่าแก๊ส",
  "ค่าใช้จ่าย",
  "ค่าของงานช่าง",
  "ค่าใช้จ่ายอื่นๆ",
  "ค่าเครื่องดื่ม"
];

// 📌 รายชื่อร้านค้าในบิล (Shop Bill Options) ทั้งหมดของระบบสำหรับทำ Dropdown
const cashoutShops = [
  "Atom",
  "ครัวกลาง",
  "pizza",
  "office",
  "ส่วนกลาง",
  "ส่วนตัว",
  "Atom_Beach",
  "Good_Time",
  "Paradise",
  "Tiger_King_Bar_&_Bistro"
];

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("CashoutForm")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าวันที่เริ่มต้นเป็น "วันที่ปัจจุบัน" (YYYY-MM-DD ตามเวลาท้องถิ่น)
  const dateFilterEl = document.getElementById("cashoutFilterDate");
  if (dateFilterEl && !dateFilterEl.value) {
    const now = new Date();
    const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split("T")[0];
    dateFilterEl.value = localToday;
  }

  initPopupImageGestures();
  populatePopupShopSelect();

  await Promise.all([
    loadMasterCategoriesAndSuppliers(),
    loadAllCashouts()
  ]);
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าบันทึกบิล Cash Out");
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

function populatePopupShopSelect() {
  const select = document.getElementById("popupBillShopSelect");
  if (!select) return;
  select.innerHTML = cashoutShops
    .map(shopVal => `<option value="${escapeHtml(shopVal)}">${escapeHtml(getDisplayShopName(shopVal))}</option>`)
    .join("");
}

// ============================================================================
// 📦 2. โหลดรายชื่อ Supplier จากระบบเดิม + เพิ่มเติมจาก Firestore
// ============================================================================
async function loadMasterCategoriesAndSuppliers() {
  const supplierSet = new Set(Object.keys(supplierCategoryMap));

  try {
    const snapSuppliers = await getDocs(collection(db, "supplier"));

    snapSuppliers.forEach(docSnap => {
      const name = docSnap.id.trim();
      const data = docSnap.data() || {};
      if (name) supplierSet.add(name);

      const dbCat = data.category || data.type || data.expense_type;
      if (name && dbCat && !supplierCategoryMap[name]) {
        supplierCategoryMap[name] = dbCat;
      }
    });
  } catch (err) {
    console.warn("⚠️ โหลดรายชื่อ Supplier เพิ่มเติมจาก Firestore ไม่สำเร็จ (ใช้ค่ามาตรฐานในระบบแทน):", err);
  }

  const sortedSuppliers = Array.from(supplierSet).sort((a, b) => a.localeCompare(b, 'th'));
  const supDl = document.getElementById("supplierCategoryOptions");
  if (supDl) {
    supDl.innerHTML = sortedSuppliers.map(s => `<option value="${escapeHtml(s)}">`).join("");
  }
}

// ============================================================================
// 📊 3. ดึงข้อมูลสรุป Cash Out รายวันของทุกสาขา (getAllCashoutData)
// ============================================================================
async function loadAllCashouts() {
  const container = document.getElementById("cashoutListContainer");
  if (container) {
    container.innerHTML = `
      <div class="text-center py-5 bg-white border rounded shadow-sm">
        <div class="spinner-border text-danger"></div>
        <p class="mt-2 mb-0 text-muted">กำลังโหลดข้อมูล Cash Out...</p>
      </div>`;
  }

  const fDateEl = document.getElementById('cashoutFilterDate');
  let targetDateStr = fDateEl ? fDateEl.value.trim() : '';
  if (!targetDateStr) {
    const now = new Date();
    targetDateStr = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split("T")[0];
    if (fDateEl) fDateEl.value = targetDateStr;
  }

  try {
    const storeTasks = TARGET_STORES.map(async (shop) => {
      const fullPathId = `${shop}/days/${targetDateStr}`;
      const cashoutDayRef = doc(db, "cashout", shop, "days", targetDateStr);
      const incomeDayRef = doc(db, "income", shop, "daily_records", targetDateStr);
      const billsColRef = collection(db, "cashout", shop, "days", targetDateStr, "bills");

      const [cashoutSnap, incomeSnap, billsSnap] = await Promise.all([
        getDoc(cashoutDayRef).catch(() => null),
        getDoc(incomeDayRef).catch(() => null),
        getDocs(billsColRef).catch(() => null)
      ]);

      let url = "";
      let status = "pending";
      let parentBillTotal = 0;

      if (cashoutSnap && cashoutSnap.exists()) {
        const f = cashoutSnap.data() || {};
        url = f.folder_url || f.url || "";
        status = f.status || "pending";
        parentBillTotal = Number(f.bill_total || f.total_amount || 0);
      }

      let cashOutAmount = 0;
      if (incomeSnap && incomeSnap.exists()) {
        const inf = incomeSnap.data() || {};
        cashOutAmount = parseFloat(inf.cash_out) || 0;
      }

      let shopBillTotal = 0;
      if (billsSnap && !billsSnap.empty) {
        billsSnap.forEach(bDoc => {
          const bf = bDoc.data() || {};
          shopBillTotal += Number(bf.bill_total) || Number(bf.total_amount) || 0;
        });
      }

      const finalBillTotal = shopBillTotal > 0 ? shopBillTotal : parentBillTotal;

      return {
        docId:           fullPathId,
        shop:            shop,
        dateShow:        targetDateStr,
        dateRaw:         targetDateStr,
        url:             url,
        status:          status,
        billTotalAmount: finalBillTotal,
        cashOutAmount:   cashOutAmount
      };
    });

    allCashouts = await Promise.all(storeTasks);
    filterCashoutTable();

  } catch (err) {
    console.error("❌ loadAllCashouts Error:", err);
    if (container) {
      container.innerHTML = `<div class="p-4 text-center text-danger bg-white border rounded">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
    }
    showToast("เกิดข้อผิดพลาด: " + err.message, "danger");
  }
}

function filterCashoutTable() {
  const fDate = document.getElementById('cashoutFilterDate')?.value || '';
  const fShop = document.getElementById('cashoutFilterShop')?.value || '';

  const filtered = (allCashouts || []).filter((i) => {
    const matchDate = fDate ? (i.dateRaw === fDate) : true;
    const matchShop = fShop ? (i.shop === fShop) : true;
    return matchDate && matchShop;
  });

  renderCashoutTable(filtered); 
}

function renderCashoutTable(data) {
  const container = document.getElementById('cashoutListContainer');
  if (!container) return;
  filteredCashouts = data; 

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="p-4 text-center text-muted border rounded bg-white shadow-sm">ไม่พบรายการในช่วงเวลาที่เลือก</div>';
    return;
  }

  const grandTotalFromBills = data.reduce((sum, item) => sum + (parseFloat(item.billTotalAmount || item.totalFromBills || 0)), 0);
  const grandTotalCashout = data.reduce((sum, item) => sum + (parseFloat(item.cashOutAmount) || 0), 0);

  const formattedGrandBillTotal = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(grandTotalFromBills);
  const formattedGrandCashout = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(grandTotalCashout);

  let html = `
    <div class="row g-2 mb-3">
      <div class="col-md-7 ms-auto">
        <div class="row g-2">
          <div class="col-6">
            <div class="card border-0 bg-success text-white shadow-sm">
              <div class="card-body py-2 px-3 d-flex justify-content-between align-items-center">
                <div>
                  <small class="text-white-50 fw-bold d-block" style="font-size: 11px;">รวมยอด cash out จากบิล</small>
                  <span class="fs-5 fw-bold">${formattedGrandBillTotal}</span> <small>บาท</small>
                </div>
                <i class="bi bi-receipt-cutoff fs-2 text-white-50"></i>
              </div>
            </div>
          </div>
          <div class="col-6">
            <div class="card border-0 bg-primary text-white shadow-sm">
              <div class="card-body py-2 px-3 d-flex justify-content-between align-items-center">
                <div>
                  <small class="text-white-50 fw-bold d-block" style="font-size: 11px;">รวมยอด cash out (ระบบ)</small>
                  <span class="fs-5 fw-bold">${formattedGrandCashout}</span> <small>บาท</small>
                </div>
                <i class="bi bi-wallet2 fs-2 text-white-50"></i>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="table-responsive shadow-sm rounded">
      <table class="table table-hover bg-white mb-0 border align-middle">
        <thead class="table-light">
          <tr class="small fw-bold text-secondary text-nowrap">
            <th>วันที่ (Date)</th>
            <th>ชื่อร้าน (Shop)</th>
            <th class="text-center">สถานะ</th>
            <th class="text-end text-success"><i class="bi bi-receipt"></i> ยอด cash out จากบิล</th>
            <th class="text-end text-primary"><i class="bi bi-calculator"></i> ยอด cash out</th> 
          </tr>
        </thead>
        <tbody>
  `;

  data.forEach((i) => {
    const displayShopName = getDisplayShopName(i.shop);
    const statusBadge = i.status === "done" 
      ? '<span class="badge bg-success"><i class="bi bi-check-circle"></i> ตรวจสอบแล้ว</span>'
      : '<span class="badge bg-danger"><i class="bi bi-exclamation-circle"></i> ยังไม่ได้ตรวจสอบ</span>';

    const formattedBillTotal = new Intl.NumberFormat('th-TH', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(i.billTotalAmount || i.totalFromBills || 0);

    const formattedAmount = new Intl.NumberFormat('th-TH', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(i.cashOutAmount || 0);

    html += `
      <tr onclick="openCashoutDetail('${escapeHtml(i.docId)}')" style="cursor:pointer;">
        <td class="fw-bold">${escapeHtml(i.dateShow || '')}</td>
        <td>
          <span class="badge bg-light text-dark border" style="font-size: 14px; padding: 5px 12px; min-width: 100px; text-align: center;">
            ${escapeHtml(displayShopName)}
          </span>
        </td>
        <td class="text-center">${statusBadge}</td>
        <td class="text-end fw-bold text-success fs-6">${formattedBillTotal}</td>
        <td class="text-end fw-bold text-primary fs-6">${formattedAmount}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
        <tfoot class="table-light fw-bold border-top">
          <tr>
            <td colspan="3" class="text-end text-secondary">ยอดรวมทั้งหมด:</td>
            <td class="text-end text-success fs-6">${formattedGrandBillTotal} บาท</td>
            <td class="text-end text-primary fs-6">${formattedGrandCashout} บาท</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
  container.innerHTML = html;
}

// ============================================================================
// 🔍 4. เปิดหน้ารายละเอียดบิลย่อยของร้านและวันที่เลือก (openCashoutDetail)
// ============================================================================
async function openCashoutDetail(docId) {
  activeDocId = docId;
  const container = document.getElementById('cashoutListContainer');
  if (container) {
    container.innerHTML = `
      <div class="text-center py-5 bg-white border rounded shadow-sm">
        <div class="spinner-border text-danger"></div>
        <p class="mt-2 mb-0 text-muted">กำลังดึงรายละเอียดบิลย่อย (${escapeHtml(docId)})...</p>
      </div>`;
  }

  try {
    const parts = docId.split('/');
    const shopName = parts[0];
    const dateKey = parts[2];

    const billsColRef = collection(db, "cashout", shopName, "days", dateKey, "bills");
    const billsSnap = await getDocs(billsColRef);

    const bills = [];
    billsSnap.forEach(bDoc => {
      const f = bDoc.data() || {};
      const rawItems = Array.isArray(f.items) ? f.items : [];
      const normalizedItems = rawItems.map(it => {
        const listName = it.list || it.name || "";
        const price = parseFloat(it.price) || 0;
        const qty = parseFloat(it.quantity ?? it.qty) || 1;
        const total = it.total !== undefined ? parseFloat(it.total) : (it.amount !== undefined ? parseFloat(it.amount) : price * qty);
        return {
          list: listName,
          name: listName,
          price: price,
          quantity: qty,
          total: total,
          amount: total
        };
      });

      const calcItemsTotal = normalizedItems.reduce((s, it) => s + (parseFloat(it.total) || 0), 0);
      const billTotal = Number(f.bill_total) || Number(f.total_amount) || calcItemsTotal;
      const supplierName = (f.supplier || f.vendor || "บิลเงินสด").toString().trim();

      bills.push({
        billId:    bDoc.id,
        dateBill:  f.date_bill || f.doc_date || f.date || dateKey,
        supplier:  supplierName,
        shopBill:  f.shop_bill || f.shop || shopName,
        billTotal: billTotal,
        category:  f.category || supplierCategoryMap[supplierName] || "",
        url:       f.url || f.file_url || f.image_url || "",
        items:     normalizedItems
      });
    });

    currentDayBillsData = bills;
    renderIntermediateBillsList(docId);

  } catch (err) {
    console.error("❌ openCashoutDetail Error:", err);
    showToast("ไม่สามารถโหลดรายละเอียดบิลย่อยได้: " + err.message, "danger");
    renderIntermediateBillsList(docId);
  }
}

function renderIntermediateBillsList(docId) {
  const container = document.getElementById('cashoutListContainer');
  if (!container) return;
  
  const grandTotalFromBills = (currentDayBillsData || []).reduce((sum, bill) => {
    return sum + (parseFloat(bill.billTotal) || 0);
  }, 0);

  const mainRecord = (allCashouts || []).find(item => item.docId === docId) || null;
  const systemCashOutAmount = mainRecord ? (parseFloat(mainRecord.cashOutAmount) || 0) : 0;

  const diffAmount = grandTotalFromBills - systemCashOutAmount;

  const formattedBillTotal = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(grandTotalFromBills);
  const formattedSystemCashout = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(systemCashOutAmount);
  const formattedDiff = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(diffAmount));

  let diffBadgeHtml = '';
  if (Math.abs(diffAmount) < 0.01) {
    diffBadgeHtml = `<span class="badge bg-success text-white border border-light fw-bold px-2 py-1"><i class="bi bi-check-circle-fill"></i> ยอดตรงกัน</span>`;
  } else if (diffAmount < 0) {
    diffBadgeHtml = `<span class="badge bg-warning text-dark border border-light fw-bold px-2 py-1"><i class="bi bi-exclamation-triangle-fill"></i> ขาดอีก ${formattedDiff} บาท</span>`;
  } else {
    diffBadgeHtml = `<span class="badge bg-info text-white border border-light fw-bold px-2 py-1"><i class="bi bi-info-circle-fill"></i> เกิน ${formattedDiff} บาท</span>`;
  }

  let html = `
    <div class="card border-danger shadow-sm mb-4">
      <div class="card-header bg-danger text-white d-flex flex-wrap justify-content-between align-items-center py-2 gap-2">
        <h5 class="mb-0 fw-bold"><i class="bi bi-folder2-open"></i> ตรวจสอบ: ${escapeHtml(docId)}</h5>
        
        <div class="d-flex flex-wrap align-items-center gap-2">
          <span class="badge bg-white text-success fw-bold fs-6 px-3 py-1 shadow-sm border border-success-subtle" title="ผลรวมคำนวณจากรูปบิลจริงทั้งหมด">
            <i class="bi bi-receipt"></i> ยอด cash out จากบิล: ${formattedBillTotal} บาท
          </span>
          <span class="badge bg-white text-primary fw-bold fs-6 px-3 py-1 shadow-sm border border-primary-subtle" title="ยอดเงินสดออกที่พนักงานแจ้งในระบบหลัก">
            <i class="bi bi-calculator"></i> ยอด cash out (ระบบ): ${formattedSystemCashout} บาท
          </span>
          ${diffBadgeHtml}
        </div>

        <button type="button" class="btn btn-sm btn-light fw-bold ms-auto ms-md-0" onclick="loadAllCashouts()">🔕 ปิดและย้อนกลับ</button>
      </div>
      <div class="card-body p-3 bg-light">
  `;

  if (!currentDayBillsData || currentDayBillsData.length === 0) {
    html += `<div class="p-4 text-center text-muted bg-white border rounded">⚠️ ไม่พบ Cash Out บันทึกไว้ในวันนี้</div></div></div>`;
    container.innerHTML = html;
    return;
  }

  currentDayBillsData.forEach((bill, index) => {
    const formattedTotal = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bill.billTotal || 0);
    
    const defaultCategory = bill.category || supplierCategoryMap[bill.supplier] || "";
    bill.category = defaultCategory;

    let categoryOptionsHtml = `<option value="">-- เลือกประเภทค่าใช้จ่าย --</option>`;
    cashoutCategories.forEach(cat => {
      const isSelected = (cat === defaultCategory) ? 'selected' : '';
      categoryOptionsHtml += `<option value="${escapeHtml(cat)}" ${isSelected}>${escapeHtml(cat)}</option>`;
    });

    const displayShopName = getDisplayShopName(bill.shopBill) || "ไม่ระบุร้านค้า";
    const isDriveUrl = bill.url && bill.url.includes("drive.google.com");
    let mediaPreviewHtml = "";

    if (bill.url) {
      if (isDriveUrl) {
        mediaPreviewHtml = `
          <div class="d-flex flex-column align-items-center justify-content-center border p-2 rounded bg-white hover-shadow" 
               style="cursor: pointer; min-height: 80px; max-width: 140px; margin: 0 auto;" 
               onclick="openBillEditModal(${index})" 
               title="บิลระบบเก่าบน Google Drive - คลิกเพื่อตรวจสอบ">
            <i class="bi bi-folder-symlink-fill text-success fs-1 mb-1"></i>
            <span class="fw-bold text-success small" style="font-size: 11px;">Google Drive</span>
          </div>
        `;
      } else {
        mediaPreviewHtml = `
          <div class="d-inline-block border p-1 rounded bg-light hover-shadow" style="cursor: pointer; max-width: 140px;" onclick="openBillEditModal(${index})">
            <img src="${escapeHtml(bill.url)}" class="img-fluid rounded" style="max-height: 80px; object-fit: contain;" title="คลิกรูปภาพเพื่อเปิดหน้าต่างป๊อปอัปแก้ไขสินค้า">
          </div>
        `;
      }
    } else {
      mediaPreviewHtml = `
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="openBillEditModal(${index})"><i class="bi bi-pencil"></i> ไม่มีรูป - กดเพื่อแก้ไขไอเทม</button>
      `;
    }

    let itemsListHtml = "";
    if (bill.items && bill.items.length > 0) {
      itemsListHtml += `
        <div class="mt-2 p-2 bg-light border border-light-subtle rounded shadow-xs" style="font-size: 13px;">
          <div class="fw-bold text-secondary mb-1"><i class="bi bi-list-check"></i> รายการสินค้าภายในบิล:</div>
          <div class="ps-1">
      `;
      
      bill.items.forEach(item => {
        const itemTotalFormatted = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2 }).format(item.total || 0);
        const itemPriceFormatted = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2 }).format(item.price || 0);
        
        itemsListHtml += `
          <div class="d-flex justify-content-between align-items-center border-bottom border-light pb-1 mb-1 text-dark">
            <span>
              <i class="bi bi-dot text-muted"></i> ${escapeHtml(item.list || "ไม่ระบุชื่อรายการ")} 
              <small class="text-muted font-monospace">( @${itemPriceFormatted} x ${item.quantity || 1} )</small>
            </span>
            <span class="fw-bold text-secondary">${itemTotalFormatted} บาท</span>
          </div>
        `;
      });
      
      itemsListHtml += `</div></div>`;
    } else {
      itemsListHtml = `
        <div class="mt-2 p-2 bg-light border border-light-subtle rounded text-muted small italic">
          <i class="bi bi-exclamation-triangle text-warning"></i> ไม่พบรายการสินค้าย่อยในบิลใบนี้ (สามารถกดปุ่มรูปขวามือเพื่อเข้าไปเพิ่มรายการได้ครับ)
        </div>
      `;
    }

    html += `
      <div class="card mb-3 border shadow-xs bg-white overflow-hidden">
        <div class="p-3">
          <div class="row align-items-center g-3">
            <div class="col-md-8">
              <div class="row g-2">
                <div class="col-sm-6"><strong>1.วันที่ในบิล Cash Out:</strong> <span class="text-secondary">${escapeHtml(cleanDateToDMY(bill.dateBill))}</span></div>
                
                <div class="col-md-12 mt-2">
                  <div class="d-flex flex-wrap align-items-center gap-3">
                    <div><strong>3.supplier:</strong> <span class="text-primary fw-bold fs-6">${escapeHtml(bill.supplier || 'บิลเงินสด')}</span></div>
                    
                    <div class="d-flex align-items-center gap-2 border-start ps-3">
                      <span class="small fw-bold text-secondary">
                        <i class="bi bi-shop text-info"></i> 2.ร้าน (shop_bill):
                      </span>
                      <span class="badge bg-light text-dark border fw-bold fs-6" style="padding: 4px 12px; min-width: 80px;">
                        ${escapeHtml(displayShopName)}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div class="col-md-10 mt-1"><strong>4.ยอดรวม:</strong> <span class="text-danger fw-bold fs-5">${formattedTotal}</span> บาท</div>
                
                <div class="col-md-12">
                  ${itemsListHtml}
                </div>
                
                <div class="col-md-10 mt-2 border-top pt-2">
                  <div class="d-flex align-items-center gap-2">
                    <label class="small fw-bold text-nowrap text-secondary m-0" style="min-width: 110px;">
                      <i class="bi bi-tag-fill text-warning"></i> 5.ประเภทค่าใช้จ่าย:
                    </label>
                    <select class="form-select form-select-sm border-secondary-subtle" style="max-width: 250px;" onchange="updateBillCategoryInCache(${index}, this.value)">
                      ${categoryOptionsHtml}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-md-4 text-center border-start">
              <div class="small fw-bold text-muted mb-1">6.รูปภาพจากการสแกน (คลิกเพื่อแก้ไขข้อมูล)</div>
              ${mediaPreviewHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  });

  html += `
      <div class="d-flex flex-wrap justify-content-between align-items-center mt-3 bg-white p-3 border rounded shadow-sm gap-3">
        <div>
          <div class="fw-bold fs-6 text-dark mb-1 d-flex flex-wrap align-items-center gap-3">
            <span class="text-success"><i class="bi bi-receipt-cutoff"></i> ยอด cash out จากบิล: <strong class="fs-5">${formattedBillTotal}</strong> บาท</span>
            <span class="text-muted">|</span>
            <span class="text-primary"><i class="bi bi-calculator"></i> ยอด cash out (ระบบ): <strong class="fs-5">${formattedSystemCashout}</strong> บาท</span>
          </div>
          <div class="small">${diffBadgeHtml}</div>
        </div>
        <button type="button" id="btnFinalSaveCashout" class="btn btn-success px-5 fw-bold shadow-sm" onclick="finalSaveToFirestore('${escapeHtml(docId)}')">
          <i class="bi bi-cloud-arrow-up-fill"></i> ยืนยันเพื่อบันทึกข้อมูล
        </button>
      </div>
    </div></div>
  `;
  container.innerHTML = html;
}

function updateBillCategoryInCache(index, categoryVal) {
  if (currentDayBillsData && currentDayBillsData[index]) {
    currentDayBillsData[index].category = categoryVal;
  }
}

// ============================================================================
// 🖼️ 5. ป๊อปอัปแก้ไขรายการสินค้าในบิลและควบคุมรูปภาพ
// ============================================================================
function openBillEditModal(index) {
  currentActiveBillIndex = index;
  const bill = currentDayBillsData[index];
  if (!bill) return;

  controlPopupImage('reset');

  const metaEl = document.getElementById('popupBillMetaDisplay');
  if (metaEl) {
    metaEl.innerHTML = `<i class="bi bi-file-earmark-text"></i> บิลที่ #${index + 1} | วันที่: ${escapeHtml(cleanDateToDMY(bill.dateBill))} | รหัสบิล: ${escapeHtml(bill.billId)}`;
  }

  const supInput = document.getElementById('popupBillSupplierInput');
  if (supInput) supInput.value = bill.supplier || "";

  const shopSelect = document.getElementById('popupBillShopSelect');
  if (shopSelect) {
    const rawBillShop = (bill.shopBill || "Atom").trim();
    const matchedOpt = Array.from(shopSelect.options).find(
      o => o.value.toLowerCase() === rawBillShop.toLowerCase() || o.value === getUnifiedShopName(rawBillShop)
    );
    if (matchedOpt) {
      shopSelect.value = matchedOpt.value;
    } else {
      const opt = document.createElement("option");
      opt.value = rawBillShop;
      opt.textContent = getDisplayShopName(rawBillShop);
      shopSelect.appendChild(opt);
      shopSelect.value = rawBillShop;
    }
  }

  const imgTarget = document.getElementById('popupBillImgTarget');
  const driveBox = document.getElementById('popupDrivePlaceholder');
  const driveLink = document.getElementById('popupDriveBtnLink');

  const url = (bill.url || "").trim();
  const isDriveOrPdf = url.includes("drive.google.com") || url.toLowerCase().includes(".pdf");

  if (!url) {
    imgTarget.classList.add('d-none');
    imgTarget.src = "";
    driveBox.classList.remove('d-none');
    driveLink.classList.add('d-none');
  } else if (isDriveOrPdf) {
    imgTarget.classList.add('d-none');
    imgTarget.src = "";
    driveBox.classList.remove('d-none');
    driveLink.classList.remove('d-none');
    driveLink.href = url;
  } else {
    driveBox.classList.add('d-none');
    imgTarget.classList.remove('d-none');
    imgTarget.src = url;
  }

  renderPopupItemsRows();

  const modal = new bootstrap.Modal(document.getElementById('cashoutDetailModal'));
  modal.show();
}

function controlPopupImage(action) {
  const img = document.getElementById('popupBillImgTarget');
  if (!img) return;

  if (action === 'zoomIn') imgZoomScale += 0.2;
  if (action === 'zoomOut') imgZoomScale = Math.max(0.2, imgZoomScale - 0.2);
  if (action === 'rotateRight') imgRotateDegree += 90;
  if (action === 'rotateLeft') imgRotateDegree -= 90;
  if (action === 'reset') { 
    imgZoomScale = 1; 
    imgRotateDegree = 0; 
    imgPanX = 0; 
    imgPanY = 0; 
  }

  img.style.transform = `scale(${imgZoomScale}) translate(${imgPanX}px, ${imgPanY}px) rotate(${imgRotateDegree}deg)`;
}

function initPopupImageGestures() {
  const wrapper = document.getElementById('popupImgWrapper');
  const img = document.getElementById('popupBillImgTarget');
  if (!wrapper || !img) return;

  wrapper.addEventListener('wheel', function(e) {
    e.preventDefault();
    if (e.deltaY < 0) {
      imgZoomScale += 0.1;
    } else {
      imgZoomScale = Math.max(0.2, imgZoomScale - 0.1);
    }
    controlPopupImage('update');
  }, { passive: false });

  img.addEventListener('mousedown', function(e) {
    e.preventDefault();
    isDraggingImg = true;
    img.style.cursor = 'grabbing';
    startDragX = e.clientX - imgPanX;
    startDragY = e.clientY - imgPanY;
  });

  document.addEventListener('mousemove', function(e) {
    if (!isDraggingImg) return;
    imgPanX = e.clientX - startDragX;
    imgPanY = e.clientY - startDragY;
    img.style.transform = `scale(${imgZoomScale}) translate(${imgPanX}px, ${imgPanY}px) rotate(${imgRotateDegree}deg)`;
  });

  const stopDragging = function() {
    if (isDraggingImg) {
      isDraggingImg = false;
      img.style.cursor = 'grab';
    }
  };
  
  document.addEventListener('mouseup', stopDragging);
  wrapper.addEventListener('mouseleave', stopDragging);
}

function savePopupSupplierToCache() {
  const supplierInput = document.getElementById('popupBillSupplierInput');
  if (supplierInput && currentActiveBillIndex !== null && currentDayBillsData[currentActiveBillIndex]) {
    const newSupplier = supplierInput.value.trim();
    const currentBill = currentDayBillsData[currentActiveBillIndex];
    const oldSupplier = currentBill.supplier;
    
    currentBill.supplier = newSupplier;
    if (newSupplier !== oldSupplier && supplierCategoryMap[newSupplier]) {
      currentBill.category = supplierCategoryMap[newSupplier];
    }
  }
}

function savePopupShopToCache() {
  const shopSelect = document.getElementById('popupBillShopSelect');
  if (shopSelect && currentActiveBillIndex !== null && currentDayBillsData[currentActiveBillIndex]) {
    currentDayBillsData[currentActiveBillIndex].shopBill = shopSelect.value;
  }
}

function renderPopupItemsRows() {
  const tbody = document.getElementById('popupItemsTableBody');
  if (!tbody) return;
  tbody.innerHTML = ''; 
  
  const bill = currentDayBillsData[currentActiveBillIndex];
  if (!bill.items || bill.items.length === 0) {
    bill.items = [{ list: "", name: "", price: 0, quantity: 1, total: 0, amount: 0 }];
  }

  bill.items.forEach((item, idx) => {
    const displayItemName = item.list || item.name || '';
    const price = parseFloat(item.price) || 0;
    const quantity = parseFloat(item.quantity) || 0;
    const currentTotal = item.total !== undefined ? item.total : (item.amount !== undefined ? item.amount : 0);
    const calcTotal = (price * quantity !== 0) ? (price * quantity).toFixed(2) : parseFloat(currentTotal).toFixed(2);
    item.total = parseFloat(calcTotal);

    tbody.innerHTML += `
      <tr class="popup-item-row">
        <td class="p-0">
          <input type="text" class="form-control form-control-sm border-0 p-item-list px-2 fs-6" value="${escapeHtml(displayItemName)}" style="min-width: 180px;">
        </td>
        <td class="p-0">
          <input type="number" class="form-control form-control-sm border-0 p-item-price text-end px-2 fs-6" step="0.01" value="${price}" oninput="recalcPopupRowTotal(this)">
        </td>
        <td class="p-0">
          <input type="number" class="form-control form-control-sm border-0 p-item-qty text-center px-2 fs-6" step="0.01" value="${quantity}" oninput="recalcPopupRowTotal(this)">
        </td>
        <td class="p-0">
          <input type="text" class="form-control form-control-sm border-0 p-item-total text-end fw-bold text-danger px-2 bg-light fs-6" value="${calcTotal}" readonly tabindex="-1">
        </td>
        <td class="text-center align-middle" style="width: 40px;">
          <i class="bi bi-trash text-muted" style="cursor:pointer; font-size: 1.1rem;" onclick="deletePopupItemRow(${idx})" title="ลบรายการสินค้าใบนี้"></i>
        </td>
      </tr>
    `;
  });
}

function recalcPopupRowTotal(inputEl) {
  const row = inputEl.closest('.popup-item-row');
  if (!row) return;
  const price = parseFloat(row.querySelector('.p-item-price').value) || 0;
  const qty = parseFloat(row.querySelector('.p-item-qty').value) || 0;
  row.querySelector('.p-item-total').value = (price * qty).toFixed(2);
}

function addPopupItemRow() {
  savePopupRowsToCache(); 
  currentDayBillsData[currentActiveBillIndex].items.push({ list: "", name: "", price: 0, quantity: 1, total: 0, amount: 0 });
  renderPopupItemsRows();
}

function deletePopupItemRow(idx) {
  savePopupRowsToCache();
  const items = currentDayBillsData[currentActiveBillIndex].items;
  if (items.length > 1) {
    items.splice(idx, 1);
  } else {
    items[0] = { list: "", name: "", price: 0, quantity: 1, total: 0, amount: 0 };
  }
  renderPopupItemsRows();
}

function savePopupRowsToCache() {
  const rows = document.querySelectorAll('.popup-item-row');
  const updatedItems = [];
  let newBillTotal = 0;

  rows.forEach(row => {
    const list = row.querySelector('.p-item-list').value.trim();
    const price = parseFloat(row.querySelector('.p-item-price').value) || 0;
    const qty = parseFloat(row.querySelector('.p-item-qty').value) || 0;
    const total = price * qty;
    
    newBillTotal += total;
    updatedItems.push({ list: list, name: list, price: price, quantity: qty, total: total, amount: total });
  });

  currentDayBillsData[currentActiveBillIndex].items = updatedItems;
  currentDayBillsData[currentActiveBillIndex].billTotal = newBillTotal; 
}

function confirmBillEdits() {
  savePopupRowsToCache();
  savePopupShopToCache();
  savePopupSupplierToCache();

  const modalElement = document.getElementById('cashoutDetailModal');
  bootstrap.Modal.getInstance(modalElement)?.hide();

  renderIntermediateBillsList(activeDocId);
  showToast("แก้ไขข้อมูลบิลและ Supplier เรียบร้อยแล้ว", "success");
}

// ============================================================================
// 💾 6. บันทึกข้อมูลบิล Cash Out ทั้งหมดลง Firestore (finalSaveToFirestore)
// ============================================================================
async function finalSaveToFirestore(docId) {
  if (!docId) return;

  const missingCategoryIdx = currentDayBillsData.findIndex(b => !b.category || b.category.trim() === "");
  if (missingCategoryIdx !== -1) {
    showSystemNotification(
      "warning",
      "⚠️ ข้อมูลยังไม่ครบถ้วน",
      `กรุณาเลือก "ประเภทค่าใช้จ่าย" ของบิลที่ #${missingCategoryIdx + 1} ก่อนกดยืนยันบันทึกข้อมูล`
    );
    return;
  }

  const btnSave = document.getElementById("btnFinalSaveCashout");
  const originalHtml = btnSave ? btnSave.innerHTML : "";
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก...`;
  }

  try {
    const parts = docId.split('/');
    const shopName = parts[0];
    const dateKey = parts[2];

    let grandTotalFromBills = 0;

    for (const bill of currentDayBillsData) {
      const billTotal = parseFloat(bill.billTotal) || 0;
      grandTotalFromBills += billTotal;

      const billRef = doc(db, "cashout", shopName, "days", dateKey, "bills", bill.billId);
      await setDoc(billRef, {
        supplier:     bill.supplier || "บิลเงินสด",
        shop_bill:    bill.shopBill || shopName,
        category:     bill.category || "",
        bill_total:   billTotal,
        total_amount: billTotal,
        items:        bill.items || [],
        status:       "done",
        updated_at:   new Date().toISOString()
      }, { merge: true });
    }

    const parentDayRef = doc(db, "cashout", shopName, "days", dateKey);
    await setDoc(parentDayRef, {
      status:       "done",
      bill_total:   grandTotalFromBills,
      total_amount: grandTotalFromBills,
      verified_by:  window.currentUser?.name || "Unknown",
      updated_at:   new Date().toISOString()
    }, { merge: true });

    await insertAuditLog(
      "VERIFY_CASHOUT",
      `ตรวจสอบและบันทึกบิล Cash Out: ${docId} ยอดรวม ${grandTotalFromBills.toLocaleString()} บาท`,
      window.currentUser
    );

    showToast("บันทึกข้อมูลบิล Cash Out สำเร็จเรียบร้อย!", "success");
    await loadAllCashouts();

  } catch (err) {
    console.error("❌ finalSaveToFirestore Error:", err);
    showSystemNotification("danger", "❌ บันทึกไม่สำเร็จ", err.message);
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = originalHtml;
    }
  }
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function showSystemNotification(type = "primary", title = "แจ้งเตือนระบบ", message = "") {
  const header = document.getElementById("notiModalHeader");
  const titleEl = document.getElementById("notiModalTitle");
  const iconEl = document.getElementById("notiModalIcon");
  const msgEl = document.getElementById("notiModalMessage");
  const cancelBtn = document.getElementById("notiCancelBtn");
  const confirmBtn = document.getElementById("notiConfirmBtn");

  header.className = `modal-header text-white py-2 bg-${type}`;
  titleEl.textContent = title;
  msgEl.textContent = message;

  if (type === "warning") {
    iconEl.innerHTML = `<i class="bi bi-exclamation-triangle-fill text-warning"></i>`;
    confirmBtn.className = "btn btn-sm btn-warning px-4 fw-bold";
  } else if (type === "danger") {
    iconEl.innerHTML = `<i class="bi bi-x-circle-fill text-danger"></i>`;
    confirmBtn.className = "btn btn-sm btn-danger px-4 fw-bold";
  } else {
    iconEl.innerHTML = `<i class="bi bi-info-circle-fill text-primary"></i>`;
    confirmBtn.className = "btn btn-sm btn-primary px-4 fw-bold";
  }

  cancelBtn.classList.add("d-none");
  confirmBtn.onclick = () => bootstrap.Modal.getInstance(document.getElementById("systemNotificationModal"))?.hide();

  new bootstrap.Modal(document.getElementById("systemNotificationModal")).show();
}

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

function getUnifiedShopName(rawShop) {
  if (!rawShop) return "Unknown";
  const lookupKey = rawShop.toString().toLowerCase().replace(/[\s_\-]+/g, '').trim();
  
  const shopMap = {
    'atom':                'Atom',        
    'atombeach':           'Atom_Beach',  
    'goodtime':            'Good_Time',   
    'paradise':            'Paradise',    
    'tiger':               'Tiger_King_Bar_&_Bistro',
    'tigerking':           'Tiger_King_Bar_&_Bistro', 
    'tigerkingbarbistro':  'Tiger_King_Bar_&_Bistro',
    'tigerkingbar&bistro': 'Tiger_King_Bar_&_Bistro',
    'office':              'Office',
    'ส่วนกลาง':             'Office',
    'kitchen':             'ครัวกลาง',
    'mainkitchen':         'ครัวกลาง',
    'ครัวกลาง':             'ครัวกลาง'
  };
  
  return shopMap[lookupKey] || rawShop.trim();
}

function cleanDateToDMY(dateStr) {
  if (!dateStr || dateStr === '-') return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr; 
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (e) {
    return dateStr;
  }
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
window.loadAllCashouts = loadAllCashouts;
window.filterCashoutTable = filterCashoutTable;
window.openCashoutDetail = openCashoutDetail;
window.updateBillCategoryInCache = updateBillCategoryInCache;
window.openBillEditModal = openBillEditModal;
window.controlPopupImage = controlPopupImage;
window.savePopupSupplierToCache = savePopupSupplierToCache;
window.savePopupShopToCache = savePopupShopToCache;
window.recalcPopupRowTotal = recalcPopupRowTotal;
window.addPopupItemRow = addPopupItemRow;
window.deletePopupItemRow = deletePopupItemRow;
window.confirmBillEdits = confirmBillEdits;
window.finalSaveToFirestore = finalSaveToFirestore;