// public/js/payment.js
import { db, storage, insertAuditLog } from "../../js/firestore.js";
import { 
  collection, 
  doc, 
  getDocs, 
  query, 
  where, 
  writeBatch 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

window.currentUser = null;
let selectedPaymentRows = [];
let isProcessingPayment = false;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("PaymentRecord")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ตั้งค่าวันที่จ่ายเริ่มต้นเป็นวันนี้
  const todayStr = new Date().toISOString().split("T")[0];
  const payDateInput = document.getElementById("payDate");
  if (payDateInput) payDateInput.value = todayStr;

  await Promise.all([
    loadShopDatalist(),
    loadPaymentRecordData()
  ]);
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าบันทึกการจ่าย");
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
// 📦 2. โหลดรายชื่อร้านค้า & รายการค้างจ่าย (แทน getUnpaidExpenses)
// ============================================================================
async function loadShopDatalist() {
  try {
    const snapShops = await getDocs(collection(db, "shop"));
    const shops = snapShops.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));
    const dl = document.getElementById("shopList");
    if (dl) {
      dl.innerHTML = shops.map(s => `<option value="${escapeHtml(s)}">`).join("");
    }
  } catch (err) {
    console.error("❌ โหลดรายชื่อร้านค้าล้มเหลว:", err);
  }
}

async function loadPaymentRecordData() {
  const area = document.getElementById('paymentListArea');
  const processArea = document.getElementById('paymentProcessArea');

  const claimStatus = document.querySelector('input[name="claimStatusFilter"]:checked')?.value || 'claimed';
  const statusText = claimStatus === 'claimed' ? 'ตั้งเบิกแล้ว' : (claimStatus === 'not_claimed' ? 'ยังไม่ตั้งเบิก' : 'ค้างจ่าย');

  area.innerHTML = `
    <div class="text-center py-5">
      <div class="spinner-border text-primary"></div>
      <p class="mt-2 text-muted">กำลังดึงข้อมูลรายการ${statusText}...</p>
    </div>`;

  if (processArea) processArea.classList.add('d-none');
  selectedPaymentRows = [];

  try {
    // ดึงรายการจาก collection 'expense' ที่ยังไม่ได้จ่ายเงิน (paid == "false")
    const q = query(collection(db, "expense"), where("paid", "==", "false"));
    const querySnapshot = await getDocs(q);

    const results = [];
    querySnapshot.forEach((docSnap) => {
      const f = docSnap.data();

      // ข้ามรายการที่จ่ายเงินแล้ว (กันพลาด)
      if (f.paid === "true" || f.paid === true) return;

      const docNoStr = String(f.doc_no || "").trim();
      const isClaimed = (f.clam_sub === "true" || f.clam_sub === true || docNoStr !== "");

      // กรองตามแท็บสถานะที่ผู้ใช้เลือก (claimed / not_claimed)
      if (claimStatus === "claimed" && !isClaimed) return;
      if (claimStatus === "not_claimed" && isClaimed) return;

      results.push({
        docId:      docSnap.id,
        ref:        docNoStr || "-",
        date:       f.doc_date ? f.doc_date.split('-').reverse().join('/') : "-",
        doc_date:   f.doc_date || "",
        supplier:   f.supplier || "ไม่ระบุ",
        shop:       f.shop || "-",
        list:       f.list || "-",
        url:        f.url || "",
        amount:     parseFloat(f.net_amount) || 0,
        invoice_no: f.invoice_no || "-"
      });
    });

    // เรียงลำดับตามวันที่เอกสารจากใหม่ไปเก่า (ถ้าเป็น 0000-00-00 จะไปอยู่ท้าย)
    results.sort((a, b) => (b.doc_date || "").localeCompare(a.doc_date || ""));

    if (results.length === 0) {
      area.innerHTML = `<div class="alert alert-info text-center m-3">ไม่พบรายการที่ตรงกับสถานะ: ${statusText}</div>`;
      document.getElementById('searchCount').innerText = "พบทั้งหมด 0 รายการ";
      return;
    }

    let html = `
      <div class="table-responsive bg-white">
        <table class="table table-sm table-hover mb-0" id="paymentRecordTable">
          <thead class="table-light sticky-top">
            <tr>
              <th class="text-center" style="width: 50px;">เลือก</th>
              <th style="width: 130px;">เลขที่ตั้งเบิก</th>
              <th style="width: 100px;">วันที่</th>
              <th>Supplier / ร้านค้า</th>
              <th>รายการ</th>
              <th class="text-center" style="width: 90px;">หลักฐาน</th>
              <th class="text-end">จำนวนเงิน</th>
            </tr>
          </thead>
          <tbody>`;

    results.forEach(item => {
      const itemJson = JSON.stringify(item).replace(/'/g, "&apos;");
      const cleanRef = String(item.ref || "").trim().toLowerCase();
      const cleanSupplier = String(item.supplier || "").trim().toLowerCase();
      const cleanShop = String(item.shop || "").trim().toLowerCase();
      const cleanAmount = String(item.amount || 0).replace(/,/g, "");

      let urlHtml = '<span class="text-muted small">-</span>';
      if (item.url && String(item.url).trim() !== "" && String(item.url).trim() !== "-") {
        const urls = String(item.url).split('\n');
        urlHtml = urls.map((u, idx) => {
          if (!u.trim()) return '';
          return `<a href="${escapeHtml(u.trim())}" target="_blank" class="btn btn-sm btn-outline-primary py-0 px-1 me-1" title="เปิดดูหลักฐานที่ ${idx + 1}">
                    <i class="bi bi-file-earmark-text"></i>
                  </a>`;
        }).join('');
      }

      html += `
        <tr class="payment-row" 
            data-ref="${escapeHtml(cleanRef)}" 
            data-supplier="${escapeHtml(cleanSupplier)}" 
            data-shop="${escapeHtml(cleanShop)}" 
            data-amount="${cleanAmount}"
            data-item='${itemJson}'>
          <td class="text-center">
            <input type="checkbox" class="form-check-input payment-chk" 
                   onchange='togglePaymentSelection(${itemJson})'>
          </td>
          <td class="small fw-bold text-primary">${escapeHtml(item.ref || '-')}</td>
          <td class="small">${escapeHtml(item.date || '-')}</td>
          <td>
            <div class="fw-bold text-success">${escapeHtml(item.supplier || '-')}</div>
            <div class="small text-muted">${escapeHtml(item.shop || '-')}</div>
          </td>
          <td class="small text-truncate" style="max-width: 180px;">${escapeHtml(item.list || '-')}</td>
          <td class="text-center">${urlHtml}</td>
          <td class="text-end fw-bold">${Number(cleanAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    area.innerHTML = html;

    filterPaymentList();

  } catch (err) {
    console.error("❌ โหลดรายการค้างจ่ายล้มเหลว:", err);
    area.innerHTML = `<div class="alert alert-danger m-3">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}

// ============================================================================
// 🔍 3. กรองรายการ & เลือกรายการจ่าย
// ============================================================================
function filterPaymentList() {
  const sRef = document.getElementById('paySearchRef').value.toLowerCase().trim();
  const sSupplier = document.getElementById('paySearchSupplier').value.toLowerCase().trim();
  const sShop = document.getElementById('paySearchShop').value.toLowerCase().trim();
  const sAmount = document.getElementById('paySearchAmount').value.trim(); 
  
  const rows = document.querySelectorAll('.payment-row'); 
  let visibleCount = 0;

  rows.forEach(row => {
    const tRef = (row.getAttribute('data-ref') || "").toLowerCase().trim();
    const tSupplier = (row.getAttribute('data-supplier') || "").toLowerCase().trim();
    const tShop = (row.getAttribute('data-shop') || "").toLowerCase().trim();
    const tAmount = (row.getAttribute('data-amount') || "").toString().trim(); 

    const matchRef = sRef === "" || tRef.includes(sRef);
    const matchSupplier = sSupplier === "" || tSupplier.includes(sSupplier);
    const matchShop = sShop === "" || tShop.includes(sShop);

    let matchAmount = true;
    if (sAmount !== "") {
      const cleanTAmount = tAmount.replace(/,/g, ""); 
      const cleanSAmount = sAmount.replace(/,/g, ""); 
      matchAmount = cleanTAmount.includes(cleanSAmount);
    }

    const isMatch = matchRef && matchSupplier && matchShop && matchAmount;
    row.style.display = isMatch ? "" : "none";
    if (isMatch) visibleCount++;
  });

  const searchCountEl = document.getElementById('searchCount');
  if (searchCountEl) searchCountEl.innerText = `พบทั้งหมด ${visibleCount} รายการ`;

  const area = document.getElementById('paymentListArea');
  let noResultMsg = document.getElementById('noPaymentResultMsg');

  if (visibleCount === 0 && rows.length > 0) {
    if (!noResultMsg) {
      const div = document.createElement('div');
      div.id = 'noPaymentResultMsg';
      div.className = 'text-center py-5 text-muted';
      div.innerHTML = '<div class="mb-2"><i class="bi bi-search fs-2"></i></div><p>ไม่พบรายการที่ตรงเงื่อนไข</p>';
      area.appendChild(div);
    }
  } else if (noResultMsg) {
    noResultMsg.remove();
  }
}

function selectVisiblePayments(status) {
  const isChecked = !!status;
  const rows = document.querySelectorAll('.payment-row');
  
  rows.forEach(row => {
    const isVisible = row.offsetWidth > 0 && row.offsetHeight > 0;
    if (isVisible) {
      const chk = row.querySelector('.payment-chk');
      const dataStr = row.getAttribute('data-item');
      if (chk && dataStr) {
        const itemData = JSON.parse(dataStr);
        chk.checked = isChecked;
        togglePaymentSelection(itemData, isChecked);
      }
    }
  });
}

function togglePaymentSelection(item, forceStatus = null) {
  const index = selectedPaymentRows.findIndex(r => r.docId === item.docId);
  
  if (forceStatus === true) {
    if (index === -1) selectedPaymentRows.push(item);
  } else if (forceStatus === false) {
    if (index > -1) selectedPaymentRows.splice(index, 1);
  } else {
    if (index > -1) selectedPaymentRows.splice(index, 1);
    else selectedPaymentRows.push(item);
  }

  updatePaymentSummaryUI();
}

function updatePaymentSummaryUI() {
  const count = selectedPaymentRows.length;
  const total = selectedPaymentRows.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
  
  const totalEl = document.getElementById('totalPaymentAmount');
  if (totalEl) totalEl.innerText = total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const badge = document.getElementById('selectedCountBadge');
  if (badge) badge.innerText = `เลือกไว้ ${count} รายการ`;

  const processArea = document.getElementById('paymentProcessArea');
  if (processArea) {
    if (count > 0) {
      processArea.classList.remove('d-none');
      processArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      processArea.classList.add('d-none');
    }
  }
}

// ============================================================================
// 💾 4. บันทึกการจ่ายและอัปโหลดหลักฐานเข้า Firebase Storage
// ============================================================================
async function processPaymentUpdate() {
  if (isProcessingPayment) return;

  const btn = document.getElementById('btnConfirmPayment');
  const slipFile = document.getElementById('paySlipFile').files[0];
  const receiptFile = document.getElementById('payReceiptFile').files[0];
  const payCh = document.getElementById('payChannel').value;
  const payDay = document.getElementById('payDate').value;

  if (selectedPaymentRows.length === 0) {
    return Swal.fire({ icon: 'warning', title: 'แจ้งเตือน', text: 'กรุณาเลือกรายการที่ต้องการจ่าย' });
  }
  if (!payCh) {
    return Swal.fire({ icon: 'warning', title: 'ข้อมูลไม่ครบ', text: 'กรุณาเลือกช่องทางการจ่าย' });
  }
  if (!payDay) {
    return Swal.fire({ icon: 'warning', title: 'ข้อมูลไม่ครบ', text: 'กรุณาเลือกวันที่จ่าย' });
  }

  isProcessingPayment = true;
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึกข้อมูล...';

  Swal.fire({
    title: 'กำลังบันทึกข้อมูล...',
    text: 'ระบบกำลังอัปโหลดไฟล์และอัปเดตสถานะ โปรดรอสักครู่',
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => { Swal.showLoading(); }
  });

  const firstItem = selectedPaymentRows[0];
  const docNo = (firstItem.ref && firstItem.ref !== "-") ? firstItem.ref : 'EXP';
  const supplier = firstItem.supplier || 'Unknown';
  const totalAmount = selectedPaymentRows.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0).toFixed(2);
  const shopFolder = getUnifiedShopName(firstItem.shop || "Unknown");

  try {
    // แตกโครงสร้าง ปี/เดือน/วัน จากวันที่โอนจ่าย (payDay: YYYY-MM-DD)
    let year = "2026", month = "01", day = "01";
    if (payDay && payDay.includes("-")) {
      const dateParts = payDay.split("-");
      year = dateParts[0] || "2026";
      month = (dateParts[1] || "01").padStart(2, '0');
      day = (dateParts[2] || "01").padStart(2, '0');
    }

    const cleanBaseName = `${docNo}_${supplier}_${totalAmount}`.replace(/[/\\?%*:|"<> ]/g, '_');

    let slipUrl = "-";
    let receiptUrl = "-";

    // 1. อัปโหลดหลักฐาน Slip เข้า Firebase Storage (slip_library)
    if (slipFile) {
      const ext = slipFile.name.split('.').pop();
      const slipPath = `slip_library/${shopFolder}/${year}/${month}/${day}/SLIP_${cleanBaseName}.${ext}`;
      const slipRef = ref(storage, slipPath);
      const slipSnap = await uploadBytes(slipRef, slipFile);
      slipUrl = await getDownloadURL(slipSnap.ref);
    }

    // 2. อัปโหลดหลักฐานใบเสร็จ Receipt เข้า Firebase Storage (slip_library)
    if (receiptFile) {
      const ext = receiptFile.name.split('.').pop();
      const receiptPath = `slip_library/${shopFolder}/${year}/${month}/${day}/RECEIPT_${cleanBaseName}.${ext}`;
      const receiptRef = ref(storage, receiptPath);
      const receiptSnap = await uploadBytes(receiptRef, receiptFile);
      receiptUrl = await getDownloadURL(receiptSnap.ref);
    }

    // 3. อัปเดตสถานะบิลค้างจ่ายทุกใบพร้อมกันด้วย Batch Write
    const batch = writeBatch(db);
    const updateData = {
      paid:    "true",
      receipt: receiptUrl,
      slip:    slipUrl,
      pay_ch:  payCh,
      pay_day: payDay,
      paid_at: new Date().toISOString()
    };

    selectedPaymentRows.forEach(item => {
      if (!item.docId) return;
      const expenseRef = doc(db, "expense", item.docId);
      batch.set(expenseRef, updateData, { merge: true });
    });

    await batch.commit();

    // 4. บันทึก Audit Log พร้อมชื่อพนักงานที่กดจ่ายเงินจริง
    await insertAuditLog(
      "PAYMENT_SUCCESS",
      `จ่ายเงินบิลเลขที่: ${docNo} ร้าน: ${shopFolder} จำนวน: ${selectedPaymentRows.length} ใบ (ยอดรวม ${totalAmount} บาท)`,
      window.currentUser
    );

    await Swal.fire({
      icon: 'success',
      title: 'สำเร็จ',
      text: 'บันทึกการจ่ายและอัปโหลดหลักฐานเรียบร้อย',
      timer: 1800,
      showConfirmButton: false
    });

    resetPaymentForm();
    await loadPaymentRecordData();

  } catch (e) {
    console.error("❌ processPaymentUpdate Error:", e);
    await insertAuditLog(
      "PAYMENT_FAIL",
      `จ่ายเงินล้มเหลว: ${docNo} สาเหตุ: ${e.message}`,
      window.currentUser
    );

    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: e.message,
      confirmButtonText: 'ตกลง'
    });
  } finally {
    isProcessingPayment = false;
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
  }
}

function resetPaymentForm() {
  selectedPaymentRows = [];
  document.getElementById('payChannel').value = "";
  document.getElementById('payDate').value = new Date().toISOString().split("T")[0];
  document.getElementById('paySlipFile').value = "";
  document.getElementById('payReceiptFile').value = "";
  const processArea = document.getElementById('paymentProcessArea');
  if (processArea) processArea.classList.add('d-none');
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function getUnifiedShopName(rawName) {
  return String(rawName || "").trim().replace(/\s+/g, "_");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ผูกฟังก์ชันเข้า window
window.loadPaymentRecordData = loadPaymentRecordData;
window.filterPaymentList = filterPaymentList;
window.selectVisiblePayments = selectVisiblePayments;
window.togglePaymentSelection = togglePaymentSelection;
window.processPaymentUpdate = processPaymentUpdate;