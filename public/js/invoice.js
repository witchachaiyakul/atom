// public/js/invoice.js
import { db, storage, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  deleteDoc, 
  query, 
  where 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  ref, 
  uploadBytes, 
  getDownloadURL, 
  deleteObject 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

window.currentUser = null;
let allInvoiceData = [];
let isSavingEdit = false;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("SearchInvoice")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  await Promise.all([
    loadMasterDatalists(),
    openSearchInvoice('unpaid')
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าค้นหาและแก้ไข Invoice");
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
// 📦 2. โหลดข้อมูลตัวเลือก (Shop / Supplier) และรายการบิลจาก Firestore
// ============================================================================
async function loadMasterDatalists() {
  try {
    const [snapShops, snapSuppliers] = await Promise.all([
      getDocs(collection(db, "shop")),
      getDocs(collection(db, "supplier"))
    ]);

    const shops = snapShops.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));
    const suppliers = snapSuppliers.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));

    const shopDl = document.getElementById("shopList");
    if (shopDl) shopDl.innerHTML = shops.map(s => `<option value="${escapeHtml(s)}">`).join("");

    const supDl = document.getElementById("supplierList");
    if (supDl) supDl.innerHTML = suppliers.map(s => `<option value="${escapeHtml(s)}">`).join("");
  } catch (err) {
    console.error("❌ โหลด Datalists ล้มเหลว:", err);
  }
}

async function openSearchInvoice(mode = 'unpaid') {
  if (mode === 'paid') {
    const btnPaid = document.getElementById('statusPaid');
    if (btnPaid) btnPaid.checked = true;
  } else {
    const btnUnpaid = document.getElementById('statusUnpaid');
    if (btnUnpaid) btnUnpaid.checked = true;
  }

  // เคลียร์ค่า Filter ตัวอักษรและวันที่
  const filters = ['filterDate', 'filterSupplier', 'filterShop', 'filterInvNo', 'filterAmount'];
  filters.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const tbody = document.getElementById('invoiceResultBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-5"><div class="spinner-border text-primary"></div><br>กำลังดึงข้อมูล...</td></tr>';
  }

  try {
    // เงื่อนไขสำหรับฟิลด์ 'paid'
    const paidFilterValues = (mode === 'paid') 
      ? ["true", true] 
      : ["", "false", false];

    const q = query(collection(db, "expense"), where("paid", "in", paidFilterValues));
    const querySnapshot = await getDocs(q);

    const mappedResults = [];
    querySnapshot.forEach((docSnap) => {
      const f = docSnap.data();
      mappedResults.push({
        docId:       docSnap.id,
        no:          f.doc_no || "",
        dateRaw:     f.doc_date || "",
        date:        f.doc_date ? f.doc_date.split('-').reverse().join('/') : "", 
        description: f.list || "",
        supplier:    f.supplier || "",
        shop:        f.shop || "",
        amount:      parseFloat(f.net_amount) || 0,
        invNo:       f.invoice_no || "",
        isSet:       (f.clam_sub === "true" || f.clam_sub === true),
        payChannel:  f.pay_ch || "",
        payDateRaw:  f.pay_day || "",
        isPaid:      (f.paid === "true" || f.paid === true),
        invoiceUrl:  f.url || "",
        receipt:     f.receipt || "",
        slip:        f.slip || ""
      });
    });

    // เรียงลำดับวันที่จากใหม่ไปเก่า (DESCENDING) และจำกัด 1,000 รายการล่าสุดเหมือนเดิม
    mappedResults.sort((a, b) => (b.dateRaw || "").localeCompare(a.dateRaw || ""));
    allInvoiceData = mappedResults.slice(0, 1000);

    displayInvoices(allInvoiceData);
    filterInvoices();

  } catch (err) {
    console.error("❌ โหลดข้อมูล Invoice ล้มเหลว:", err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-danger">ไม่สามารถโหลดข้อมูลได้: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ============================================================================
// 🔍 3. แสดงผลตารางและกรองข้อมูลหน้าเว็บ
// ============================================================================
function displayInvoices(data) {
  const tbody = document.getElementById('invoiceResultBody');
  if (!tbody) return;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-5 text-muted">ไม่พบข้อมูลที่ต้องการค้นหา</td></tr>';
    const countEl = document.getElementById('invoiceCountDisplay');
    if (countEl) countEl.innerText = "แสดงทั้งหมด 0 รายการ";
    return;
  }

  const allRowsHTML = data.map(item => {
    const amountValue = parseFloat(item.amount) || 0;
    const isPaidStatus = (item.isPaid === true || item.isPaid === "true") ? "paid" : "unpaid";

    const id = escapeHtml(item.docId); 
    const dNo = escapeHtml(item.no || '-'); 
    const dDate = escapeHtml(item.dateRaw || ""); 
    const dSupplier = escapeHtml((item.supplier || "").toLowerCase());
    const dShop = escapeHtml((item.shop || "").toLowerCase());
    const dInvNo = escapeHtml((item.invNo || "").toLowerCase());
    const dAmount = amountValue.toString();

    return `
      <tr class="invoice-row" 
          data-date="${dDate}" 
          data-supplier="${dSupplier}" 
          data-shop="${dShop}" 
          data-invno="${dInvNo}" 
          data-amount="${dAmount}"
          data-ispaid="${isPaidStatus}">
        <td><span class="badge bg-secondary">${dNo}</span></td>
        <td>${escapeHtml(item.date || '-')}</td>
        <td>${escapeHtml(item.supplier || '-')}</td>
        <td>${escapeHtml(item.shop || '-')}</td>
        <td>${escapeHtml(item.invNo || '-')}</td>
        <td class="text-end fw-bold">${amountValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary" onclick="prepareEditInvoice('${id}')">
            <i class="bi bi-pencil"></i> แก้ไข
          </button>
        </td>
      </tr>`;
  }).join('');

  tbody.innerHTML = allRowsHTML;
}

function filterInvoices() {
  const statusRadio = document.querySelector('input[name="statusFilter"]:checked');
  const fStatus = statusRadio ? statusRadio.value : 'unpaid';
  
  const fDate = document.getElementById('filterDate').value; 
  const fSupplier = document.getElementById('filterSupplier').value.toLowerCase().trim();
  const fShop = document.getElementById('filterShop').value.toLowerCase().trim();
  const fInvNo = document.getElementById('filterInvNo').value.toLowerCase().trim();
  const fAmount = document.getElementById('filterAmount').value.trim();

  const rows = document.querySelectorAll('#invoiceResultBody tr.invoice-row');
  let visibleCount = 0;

  rows.forEach(row => {
    const tStatus = row.getAttribute('data-ispaid'); 
    const tDate = row.getAttribute('data-date') || ""; 
    const tSupplier = row.getAttribute('data-supplier') || "";
    const tShop = row.getAttribute('data-shop') || "";
    const tInvNo = row.getAttribute('data-invno') || "";
    const tAmount = row.getAttribute('data-amount') || "";

    const matchStatus = (tStatus === fStatus);
    const matchDate = fDate === "" || tDate.includes(fDate);
    const matchSupplier = fSupplier === "" || tSupplier.includes(fSupplier);
    
    let matchShop = false;
    if (fShop === "") {
      matchShop = true; 
    } else if (fShop === "atom") {
      matchShop = (tShop === "atom");
    } else {
      matchShop = tShop.includes(fShop);
    }

    const matchInvNo = fInvNo === "" || tInvNo.includes(fInvNo);
    const matchAmount = fAmount === "" || tAmount.includes(fAmount);

    if (matchStatus && matchDate && matchSupplier && matchShop && matchInvNo && matchAmount) {
      row.style.display = "";
      visibleCount++;
    } else {
      row.style.display = "none";
    }
  });

  const countEl = document.getElementById('invoiceCountDisplay');
  if (countEl) countEl.innerText = `แสดงทั้งหมด ${visibleCount} รายการ`;
}

function clearInvoiceFilter() {
  const filters = ['filterDate', 'filterSupplier', 'filterShop', 'filterInvNo', 'filterAmount'];
  filters.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  filterInvoices();
}

// ============================================================================
// ✏️ 4. เตรียมข้อมูลเข้า Modal แก้ไขบิล (prepareEditInvoice)
// ============================================================================
function prepareEditInvoice(docId) {
  const item = allInvoiceData.find(d => d.docId === docId);
  if (!item) {
    alert("ไม่พบข้อมูลรายการที่เลือก");
    return;
  }

  document.getElementById('editDocNoDisplay').innerText = item.no || item.docId;
  document.getElementById('editRowNum').value = item.docId;
  document.getElementById('editDate').value = (item.dateRaw && item.dateRaw !== "0000-00-00") ? item.dateRaw : "";
  document.getElementById('editInvNo').value = item.invNo || "";
  document.getElementById('editDescription').value = item.description || "";
  document.getElementById('editSupplier').value = item.supplier || "";
  document.getElementById('editShop').value = item.shop || "";
  document.getElementById('editAmount').value = item.amount || 0;

  document.getElementById('editIsSet').checked = !!item.isSet;
  document.getElementById('editPayDate').value = item.payDateRaw || "";
  document.getElementById('editIsPaid').checked = !!item.isPaid;

  // เลือกช่องทางการจ่ายใน Select (รองรับทั้งตัวพิมพ์เล็ก-ใหญ่และภาษาไทย)
  const paySelect = document.getElementById('editPayChannel');
  const rawCh = (item.payChannel || "").trim();
  const matchedOption = Array.from(paySelect.options).find(opt => opt.value.toLowerCase() === rawCh.toLowerCase());
  paySelect.value = matchedOption ? matchedOption.value : "";

  // ล้างช่องเลือกไฟล์ใหม่
  document.getElementById('editFileInput').value = "";
  document.getElementById('editReceiptInput').value = "";
  document.getElementById('editSlipInput').value = "";

  // แสดงลิงก์ไฟล์ประวัติเดิม (รองรับหลายไฟล์คั่นด้วย \n)
  const urlArea = document.getElementById('urlDisplayArea');
  if (item.invoiceUrl && item.invoiceUrl !== "-" && item.invoiceUrl.trim() !== "") {
    const urls = item.invoiceUrl.split('\n').filter(u => u.trim() !== "");
    urlArea.innerHTML = urls.map((u, idx) => 
      `<a href="${escapeHtml(u.trim())}" target="_blank" class="btn btn-sm btn-outline-secondary m-1">
        <i class="bi bi-file-earmark-text"></i> เปิดไฟล์แนบที่ ${idx + 1}
      </a>`
    ).join('');
  } else {
    urlArea.innerHTML = '<span class="text-muted small">ไม่มีไฟล์แนบเดิม</span>';
  }

  // แสดงลิงก์ไฟล์ใบเสร็จ (Receipt)
  const receiptArea = document.getElementById('receiptUrlDisplayArea');
  if (item.receipt && item.receipt !== "-" && item.receipt.trim() !== "") {
    receiptArea.innerHTML = `<a href="${escapeHtml(item.receipt.trim())}" target="_blank" class="btn btn-sm btn-outline-primary">
      <i class="bi bi-file-earmark-check"></i> เปิดดูใบเสร็จ
    </a>`;
  } else {
    receiptArea.innerHTML = '<span class="text-muted small">ยังไม่มีไฟล์ใบเสร็จ</span>';
  }

  // แสดงลิงก์ไฟล์สลิป (Slip)
  const slipArea = document.getElementById('slipUrlDisplayArea');
  if (item.slip && item.slip !== "-" && item.slip.trim() !== "") {
    slipArea.innerHTML = `<a href="${escapeHtml(item.slip.trim())}" target="_blank" class="btn btn-sm btn-outline-success">
      <i class="bi bi-image"></i> เปิดดูสลิปโอนเงิน
    </a>`;
  } else {
    slipArea.innerHTML = '<span class="text-muted small">ยังไม่มีไฟล์สลิป</span>';
  }

  const editModal = new bootstrap.Modal(document.getElementById('editInvoiceModal'));
  editModal.show();
}

// ============================================================================
// 💾 5. บันทึกการแก้ไขและอัปโหลดไฟล์ใหม่เข้า Firebase Storage
// ============================================================================
async function saveEditInvoice() {
  if (isSavingEdit) return;

  const docId = document.getElementById('editRowNum').value;
  if (!docId) return alert("ไม่พบรหัสเอกสาร (docId)");

  const btnSave = document.getElementById('btnSaveEditInvoice');
  const originalBtnHtml = btnSave.innerHTML;
  isSavingEdit = true;
  btnSave.disabled = true;
  btnSave.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก...`;

  try {
    const rawDate = document.getElementById('editDate').value;
    const rawSupplier = document.getElementById('editSupplier').value.trim();
    const rawShop = document.getElementById('editShop').value.trim();
    const rawInvNo = document.getElementById('editInvNo').value.trim();
    const netAmt = parseFloat(document.getElementById('editAmount').value) || 0;

    let year = "2026", month = "01", day = "01";
    if (rawDate && rawDate.includes("-")) {
      const dateParts = rawDate.split("-");
      year = dateParts[0] || "2026";
      month = (dateParts[1] || "01").padStart(2, '0');
      day = (dateParts[2] || "01").padStart(2, '0');
    }

    const shopFolder = getUnifiedShopName(rawShop);
    const invNo = rawInvNo || "NO-IV";

    // ท่อที่ 1: อัปโหลดไฟล์แนบหลัก (รองรับหลายไฟล์)
    let combinedUrls = "";
    const fileInput = document.getElementById('editFileInput');
    if (fileInput && fileInput.files.length > 0) {
      const files = Array.from(fileInput.files);
      const urlList = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ext = f.name.split('.').pop();
        const finalFileName = `${invNo}_${rawSupplier}_${netAmt}_${i + 1}.${ext}`;
        const storagePath = `invoice_library/${shopFolder}/${year}/${month}/${day}/${finalFileName}`;
        const snap = await uploadBytes(ref(storage, storagePath), f);
        const dlUrl = await getDownloadURL(snap.ref);
        urlList.push(dlUrl);
      }
      combinedUrls = urlList.join("\n");
    }

    // ท่อที่ 2: อัปโหลดไฟล์ใบเสร็จ (Receipt)
    let receiptUrlResult = "";
    const receiptInput = document.getElementById('editReceiptInput');
    if (receiptInput && receiptInput.files.length > 0) {
      const rFile = receiptInput.files[0];
      const rExt = rFile.name.split('.').pop();
      const receiptFileName = `${invNo}_${rawSupplier}_${netAmt}_receipt.${rExt}`;
      const receiptPath = `invoice_library/${shopFolder}/${year}/${month}/${day}/${receiptFileName}`;
      const rSnap = await uploadBytes(ref(storage, receiptPath), rFile);
      receiptUrlResult = await getDownloadURL(rSnap.ref);
    }

    // ท่อที่ 3: อัปโหลดไฟล์สลิปโอนเงิน (Slip)
    let slipUrlResult = "";
    const slipInput = document.getElementById('editSlipInput');
    if (slipInput && slipInput.files.length > 0) {
      const sFile = slipInput.files[0];
      const sExt = sFile.name.split('.').pop();
      const slipFileName = `${invNo}_${rawSupplier}_${netAmt}_slip.${sExt}`;
      const slipPath = `slip_library/${shopFolder}/${year}/${month}/${day}/${slipFileName}`;
      const sSnap = await uploadBytes(ref(storage, slipPath), sFile);
      slipUrlResult = await getDownloadURL(sSnap.ref);
    }

    // เตรียมข้อมูลอัปเดตลง Firestore
    const updateData = {
      doc_date:         rawDate || "0000-00-00",
      list:             document.getElementById('editDescription').value.trim(),
      supplier:         rawSupplier,
      shop:             shopFolder,
      net_amount:       netAmt,
      total_amount:     netAmt,
      invoice_no:       rawInvNo,
      clam_sub:         document.getElementById('editIsSet').checked ? "true" : "false",
      pay_ch:           document.getElementById('editPayChannel').value,
      pay_day:          document.getElementById('editPayDate').value,
      paid:             document.getElementById('editIsPaid').checked ? "true" : "false",
      timestamp_update: new Date().toISOString()
    };

    if (combinedUrls !== "") updateData.url = combinedUrls;
    if (receiptUrlResult !== "") updateData.receipt = receiptUrlResult;
    if (slipUrlResult !== "") updateData.slip = slipUrlResult;

    await setDoc(doc(db, "expense", docId), updateData, { merge: true });

    await insertAuditLog(
      "UPDATE_INVOICE",
      `แก้ไขข้อมูลบิล: ${docId} ร้าน: ${shopFolder}`,
      window.currentUser
    );

    bootstrap.Modal.getInstance(document.getElementById('editInvoiceModal'))?.hide();
    showToast("อัปเดตข้อมูล Invoice สำเร็จ", "success");

    const currentMode = document.querySelector('input[name="statusFilter"]:checked')?.value || 'unpaid';
    await openSearchInvoice(currentMode);

  } catch (error) {
    console.error("❌ saveEditInvoice Error:", error);
    alert("บันทึกไม่สำเร็จ: " + error.message);
  } finally {
    isSavingEdit = false;
    btnSave.disabled = false;
    btnSave.innerHTML = originalBtnHtml;
  }
}

// ============================================================================
// 🗑️ 6. ลบบิลและไฟล์แนบใน Storage (deleteInvoice & executeDelete)
// ============================================================================
function deleteInvoice() {
  const docId = document.getElementById('editRowNum').value; 
  const shop = document.getElementById('editShop').value;

  if (!docId) {
    alert("ไม่พบรหัสเอกสาร");
    return;
  }

  document.getElementById('deleteShopName').innerText = getDisplayShopName(shop);
  const delModal = new bootstrap.Modal(document.getElementById('deleteConfirmModal'));
  delModal.show();
}

async function executeDelete() {
  const docId = document.getElementById('editRowNum').value;
  const btn = document.getElementById('btnConfirmDeleteFinal');
  if (!docId) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> กำลังลบ...';

  try {
    const expenseRef = doc(db, "expense", docId);
    const docSnap = await getDoc(expenseRef);

    // 1. ลบไฟล์แนบทั้งหมด (url, receipt, slip) ออกจาก Firebase Storage ก่อน
    if (docSnap.exists()) {
      const f = docSnap.data();
      const allUrlsRaw = [f.url, f.receipt, f.slip]
        .filter(val => val && val !== "-" && String(val).includes("firebasestorage.googleapis.com"))
        .join("\n");

      const urls = allUrlsRaw.split("\n");
      for (const rawUrl of urls) {
        const trimmedUrl = rawUrl.trim();
        if (!trimmedUrl) continue;

        const match = trimmedUrl.match(/\/o\/(.+?)\?/);
        if (match && match[1]) {
          const storagePath = decodeURIComponent(match[1]);
          try {
            await deleteObject(ref(storage, storagePath));
            console.log(`✅ ลบไฟล์ใน Storage สำเร็จ: ${storagePath}`);
          } catch (storageErr) {
            console.warn(`⚠️ ข้ามการลบไฟล์ใน Storage (อาจถูกลบไปแล้ว): ${storagePath}`, storageErr);
          }
        }
      }
    }

    // 2. ลบเอกสารออกจาก Firestore
    await deleteDoc(expenseRef);

    // 3. บันทึก Audit Log
    await insertAuditLog("DELETE_INVOICE", `ลบบิลเลขที่: ${docId}`, window.currentUser);

    bootstrap.Modal.getInstance(document.getElementById('deleteConfirmModal'))?.hide();
    bootstrap.Modal.getInstance(document.getElementById('editInvoiceModal'))?.hide();

    showToast("ลบข้อมูลและไฟล์แนบสำเร็จแล้ว", "danger");

    const currentMode = document.querySelector('input[name="statusFilter"]:checked')?.value || 'unpaid';
    await openSearchInvoice(currentMode);

  } catch (e) {
    console.error("❌ Delete Invoice Error:", e);
    alert("ลบไม่สำเร็จ: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'ลบทันที';
  }
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
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
window.openSearchInvoice = openSearchInvoice;
window.filterInvoices = filterInvoices;
window.clearInvoiceFilter = clearInvoiceFilter;
window.prepareEditInvoice = prepareEditInvoice;
window.saveEditInvoice = saveEditInvoice;
window.deleteInvoice = deleteInvoice;
window.executeDelete = executeDelete;