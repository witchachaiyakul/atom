// public/js/expense.js
import { db, storage, insertAuditLog } from "../../js/firestore.js";
import { 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  writeBatch,
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

window.currentUser = null;
let isDropdownLoaded = false;
let isProcessing = false;
let invoiceCount = 1;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("ExpenseEntry")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // โหลดตัวเลือก Master Data (สาขา, Supplier, ประเภทค่าใช้จ่าย)
  await loadDropdowns();
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าบันทึกค่าใช้จ่าย");
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
// 📦 2. โหลดข้อมูล Master Data (แทน getDropdownData & loadDropdowns)
// ============================================================================
async function loadDropdowns() {
  isDropdownLoaded = false;
  try {
    const [snapList, snapShops, snapSuppliers] = await Promise.all([
      getDocs(collection(db, "list")),
      getDocs(collection(db, "shop")),
      getDocs(collection(db, "supplier"))
    ]);

    const items = snapList.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));
    const shops = snapShops.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));
    const suppliers = snapSuppliers.docs.map(d => d.id).sort((a, b) => a.localeCompare(b, 'th'));

    updateAllDatalists({ items, shops, suppliers });
    isDropdownLoaded = true;
    console.log(`✅ โหลด Master Data สำเร็จ (สาขา: ${shops.length}, Supplier: ${suppliers.length}, ประเภท: ${items.length})`);
  } catch (err) {
    console.error("❌ Load Dropdowns Error:", err);
    showToast("โหลดข้อมูลตัวเลือกไม่สำเร็จ: " + err.message, "danger");
  }
}

function updateAllDatalists(data) {
  const fillDatalist = (elementId, arr) => {
    const dl = document.getElementById(elementId);
    if (!dl) return;
    dl.innerHTML = arr.map(val => `<option value="${escapeHtml(val)}">`).join("");
  };

  fillDatalist("itemList", data.items || []);
  fillDatalist("shopList", data.shops || []);
  fillDatalist("supplierList", data.suppliers || []);
}

// ============================================================================
// ➕ 3. บันทึก Master Data ใหม่ (Supplier, List, และ addNew)
// ============================================================================
async function saveNewSupplierMaster() {
  const supplierId = document.getElementById('m_supplier_id').value.trim();
  if (!supplierId) {
    alert("กรุณากรอกชื่อย่อ Supplier (ใช้เป็น ID) ก่อนครับ");
    return;
  }

  const data = {
    supplier: supplierId,
    name:     document.getElementById('m_supplier_name').value.trim() || supplierId,
    tax_id:   document.getElementById('m_supplier_tax').value.trim() || "-",
    address:  document.getElementById('m_supplier_address').value.trim() || "-",
    bank_id:  document.getElementById('m_supplier_bank').value.trim() || "-",
    note:     "done",
    updated_at: serverTimestamp()
  };

  try {
    await setDoc(doc(db, "supplier", supplierId), data, { merge: true });
    await insertAuditLog("NEW_SUPPLIER", `เพิ่ม Supplier ใหม่: ${supplierId} (${data.name})`, window.currentUser);

    const modalEl = document.getElementById('modalAddSupplier');
    bootstrap.Modal.getInstance(modalEl)?.hide();
    document.querySelectorAll('#modalAddSupplier input, #modalAddSupplier textarea').forEach(el => el.value = "");

    showToast(`เพิ่ม Supplier "${supplierId}" เรียบร้อยแล้ว`, "success");
    await loadDropdowns();
  } catch (err) {
    console.error("❌ Save Supplier Error:", err);
    alert("บันทึก Supplier ไม่สำเร็จ: " + err.message);
  }
}

async function saveNewListMaster() {
  const listName = document.getElementById('m_list_name').value.trim();
  if (!listName) {
    alert("กรุณากรอกชื่อประเภทรายการก่อนครับ");
    return;
  }

  try {
    await setDoc(doc(db, "list", listName), {
      name: listName,
      updated_at: serverTimestamp()
    }, { merge: true });

    await insertAuditLog("NEW_LIST", `เพิ่มประเภทค่าใช้จ่ายใหม่: ${listName}`, window.currentUser);

    const modalEl = document.getElementById('modalAddList');
    bootstrap.Modal.getInstance(modalEl)?.hide();
    document.getElementById('m_list_name').value = "";

    showToast(`เพิ่มประเภท "${listName}" เรียบร้อยแล้ว`, "success");
    await loadDropdowns();
  } catch (err) {
    console.error("❌ Save List Error:", err);
    alert("บันทึกประเภทค่าใช้จ่ายไม่สำเร็จ: " + err.message);
  }
}

async function addNew(type) {
  const val = prompt("ป้อนข้อมูลใหม่:");
  if (!val || !val.trim()) return;

  try {
    let docId = val.trim();

    if (type === 'item') {
      await setDoc(doc(db, "list", docId), { name: docId }, { merge: true });
    } else if (type === 'shop') {
      docId = getUnifiedShopName(docId);
      await setDoc(doc(db, "shop", docId), {
        name: docId,
        address: "-",
        tax_id: "-",
        logo: ""
      }, { merge: true });
    } else if (type === 'supplier') {
      await setDoc(doc(db, "supplier", docId), {
        supplier: docId,
        name: docId,
        address: "-",
        bank_id: "-",
        tax_id: "-",
        note: "done"
      }, { merge: true });
    }

    await insertAuditLog("NEW_OPTION", `เพิ่ม ${type} ใหม่ชื่อ: ${docId}`, window.currentUser);
    showToast(`เพิ่ม "${docId}" เรียบร้อยแล้ว`, "success");
    await loadDropdowns();
  } catch (e) {
    console.error("Error in addNew:", e);
    alert("ไม่สามารถเพิ่มข้อมูลใหม่ได้: " + e.message);
  }
}

// ============================================================================
// 🧮 4. คำนวณภาษี VAT 7% & จัดการ UI การ์ด Invoice
// ============================================================================
function toggleVatDisplay(radio) {
  const cardBody = radio.closest('.card-body');
  const vatSection = cardBody.querySelector('.vat-calculation-section');
  vatSection.style.display = (radio.value === 'has-vat') ? 'block' : 'none';
  calculateVat(radio);
}

function calculateVat(el) {
  const cardBody = el.closest('.card-body');
  const netAmount = parseFloat(cardBody.querySelector('.net-amount').value) || 0;
  const vatType = cardBody.querySelector('.vat-type:checked').value;
  const exemptType = cardBody.querySelector('.exempt-type:checked').value;
  const exemptInputBox = cardBody.querySelector('.exempt-input-box');
  const exemptAmount = parseFloat(cardBody.querySelector('.exempt-amount').value) || 0;

  exemptInputBox.style.display = (exemptType === 'has-exempt') ? 'flex' : 'none';

  if (vatType === 'has-vat') {
    const baseForVat = (exemptType === 'has-exempt') ? netAmount - exemptAmount : netAmount;
    const priceBeforeVat = (baseForVat * 100) / 107;
    const vatValue = (baseForVat * 7) / 107;
    cardBody.querySelector('.base-price').value = priceBeforeVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    cardBody.querySelector('.vat-value').value = vatValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    cardBody.querySelector('.base-price').value = '0.00';
    cardBody.querySelector('.vat-value').value = '0.00';
  }
}

function validateFileLimit(input) {
  const maxFiles = 5;
  const files = input.files;
  const displayDiv = input.parentElement.querySelector('.file-list-display');

  if (files.length > maxFiles) {
    alert("แนบไฟล์ได้สูงสุด 5 ไฟล์ต่อ 1 ใบ Invoice เท่านั้นครับ");
    input.value = "";
    if (displayDiv) displayDiv.innerHTML = "";
    return;
  }

  if (displayDiv && files.length > 0) {
    let html = '<ul class="mb-0 ps-3 mt-1 text-primary shadow-sm p-2 bg-white rounded" style="list-style-type: decimal; font-size: 0.75rem;">';
    for (let i = 0; i < files.length; i++) {
      html += `<li>${escapeHtml(files[i].name)}</li>`;
    }
    html += '</ul>';
    displayDiv.innerHTML = html;
  } else if (displayDiv) {
    displayDiv.innerHTML = "";
  }
}

function addNewInvoiceBlock() {
  invoiceCount++;
  const idx = invoiceCount;
  const container = document.getElementById('invoiceList');

  const blockHtml = `
    <div class="card shadow-sm mb-4 invoice-item border-primary">
      <div class="card-header bg-light d-flex justify-content-between align-items-center">
        <span class="fw-bold text-primary invoice-title">Invoice รายการที่ ${idx}</span>
        <button type="button" class="btn btn-sm btn-outline-danger border-0 btn-remove-invoice" onclick="removeInvoice(this)">
          <i class="bi bi-trash"></i> ลบรายการนี้
        </button>
      </div>

      <div class="card-body bg-white">
        <div class="row g-2 mb-4 pb-3 border-bottom">
          <div class="col-6 col-md-2">
            <label class="form-label small fw-bold">เลขที่เอกสาร</label>
            <input type="text" class="form-control form-control-sm doc-no" placeholder="เลขที่ IV...">
          </div>
          <div class="col-6 col-md-2">
            <label class="form-label small fw-bold">วันที่เอกสาร</label>
            <input type="date" class="form-control form-control-sm doc-date">
          </div>
          <div class="col-6 col-md-2">
            <label class="form-label small fw-bold">ร้าน (สาขา)</label>
            <input list="shopList" class="form-control form-control-sm shop-name" placeholder="เลือกสาขา...">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small fw-bold">Supplier</label>
            <input list="supplierList" class="form-control form-control-sm supplier-name" placeholder="ชื่อผู้ขาย...">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small fw-bold">ประเภทค่าใช้จ่าย</label>
            <input list="itemList" class="form-control form-control-sm item-type" placeholder="ประเภท/รายการ...">
          </div>
        </div>

        <div class="row g-4">
          <div class="col-md-5 border-end">
            <div class="p-3 border rounded bg-light-subtle h-100 d-flex flex-column justify-content-center">
              <label class="form-label fw-bold small"><i class="bi bi-paperclip"></i> แนบไฟล์ Invoice (สูงสุด 5 ไฟล์)</label>
              <input type="file" class="form-control form-control-sm invoice-file" multiple accept="image/*,.pdf" onchange="validateFileLimit(this)">
              <div class="file-list-display mt-2 text-start small text-primary"></div>
              <p class="text-muted small mt-2 mb-0 text-center">เลือกได้หลายไฟล์พร้อมกัน (ภาพหรือ PDF)</p>
            </div>
          </div>

          <div class="col-md-7">
            <label class="form-label small fw-bold mb-2 text-secondary">การจัดการภาษี</label>
            <div class="d-flex gap-4 mb-3 p-2 border rounded bg-white">
              <div class="form-check">
                <input class="form-check-input vat-type" type="radio" name="vatGroup${idx}" value="no-vat" checked onchange="toggleVatDisplay(this)">
                <label class="form-check-input-label small fw-bold">ไม่มี VAT 7%</label>
              </div>
              <div class="form-check">
                <input class="form-check-input vat-type" type="radio" name="vatGroup${idx}" value="has-vat" onchange="toggleVatDisplay(this)">
                <label class="form-check-input-label small fw-bold text-primary">มี VAT 7%</label>
              </div>
            </div>

            <div class="vat-calculation-section p-3 border rounded bg-light mb-3" style="display: none;">
              <div class="d-flex gap-3 mb-3 pb-2 border-bottom">
                <div class="form-check">
                  <input class="form-check-input exempt-type" type="radio" name="exemptGroup${idx}" value="no-exempt" checked onchange="calculateVat(this)">
                  <label class="form-check-input-label small">ไม่มีรายการยกเว้นภาษี</label>
                </div>
                <div class="form-check">
                  <input class="form-check-input exempt-type" type="radio" name="exemptGroup${idx}" value="has-exempt" onchange="calculateVat(this)">
                  <label class="form-check-input-label small text-danger">มีรายการยกเว้นภาษี</label>
                </div>
              </div>
              <div class="row g-2 mb-2 exempt-input-box" style="display: none;">
                <div class="col-7 text-end small">ยอดที่ได้รับยกเว้นภาษี (Non-VAT):</div>
                <div class="col-5"><input type="number" class="form-control form-control-sm text-end exempt-amount" value="0" oninput="calculateVat(this)"></div>
              </div>
              <div class="row g-2 mb-2">
                <div class="col-7 text-end small">ราคาสินค้า (ฐานภาษี):</div>
                <div class="col-5"><input type="text" class="form-control form-control-sm text-end bg-white base-price" readonly value="0.00"></div>
              </div>
              <div class="row g-2">
                <div class="col-7 text-end small">ภาษีมูลค่าเพิ่ม (7%):</div>
                <div class="col-5"><input type="text" class="form-control form-control-sm text-end bg-white vat-value" readonly value="0.00"></div>
              </div>
            </div>

            <div class="p-3 border-top mt-2">
              <div class="row g-2 align-items-center">
                <div class="col-7 text-end fw-bold text-primary" style="font-size: 1.1rem;">ยอดสุทธิรวม (ที่จ่ายจริง):</div>
                <div class="col-5">
                  <input type="number" class="form-control form-control-lg fw-bold border-primary text-end net-amount" 
                         placeholder="0.00" oninput="calculateVat(this)" style="background-color: #fff9e6;">
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', blockHtml);
  updateInvoiceTitles();
}

function removeInvoice(btn) {
  if (confirm('ยืนยันการลบรายการนี้?')) {
    btn.closest('.invoice-item').remove();
    updateInvoiceTitles();
  }
}

function updateInvoiceTitles() {
  const items = document.querySelectorAll('.invoice-item');
  items.forEach((item, index) => {
    item.querySelector('.invoice-title').innerText = `Invoice รายการที่ ${index + 1}`;
    const removeBtn = item.querySelector('.btn-remove-invoice');
    if (removeBtn) removeBtn.style.display = items.length > 1 ? 'block' : 'none';
  });
}

function startNewEntry() {
  document.getElementById('invoiceList').innerHTML = '';
  invoiceCount = 0;
  addNewInvoiceBlock();

  const modalEl = document.getElementById('successModal');
  const modal = bootstrap.Modal.getInstance(modalEl);
  if (modal) modal.hide();

  window.scrollTo(0, 0);
}

// ============================================================================
// 💾 5. บันทึกข้อมูล Invoice ทั้งหมด (แทน submitAllData + saveInvoiceBulk)
// ============================================================================
async function submitAllData() {
  if (isProcessing) return;

  const invoiceItems = document.querySelectorAll('.invoice-item');
  if (invoiceItems.length === 0) return;

  // ตรวจสอบข้อมูลเบื้องต้นก่อนเริ่มอัปโหลด
  for (let i = 0; i < invoiceItems.length; i++) {
    const netVal = parseFloat(invoiceItems[i].querySelector('.net-amount').value) || 0;
    const shopVal = invoiceItems[i].querySelector('.shop-name').value.trim();
    const supVal = invoiceItems[i].querySelector('.supplier-name').value.trim();
    if (!shopVal || !supVal || netVal <= 0) {
      alert(`กรุณากรอกข้อมูล "ร้าน (สาขา)", "Supplier" และ "ยอดสุทธิ" ในรายการที่ ${i + 1} ให้ครบถ้วนครับ`);
      return;
    }
  }

  isProcessing = true;
  const btnSubmit = document.getElementById("btnSubmitAll");
  const originalBtnHtml = btnSubmit.innerHTML;
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังประมวลผล...`;

  try {
    const batch = writeBatch(db);
    const savedSummaryList = [];

    for (let index = 0; index < invoiceItems.length; index++) {
      const item = invoiceItems[index];

      const rawDocNo   = item.querySelector('.doc-no').value.trim();
      const rawDate    = item.querySelector('.doc-date').value.trim();
      const rawShop    = item.querySelector('.shop-name').value.trim();
      const rawSup     = item.querySelector('.supplier-name').value.trim();
      const rawList    = item.querySelector('.item-type').value.trim();
      const netAmount  = cleanNum(item.querySelector('.net-amount').value);
      const nonVat     = cleanNum(item.querySelector('.exempt-amount').value);
      const exVat      = cleanNum(item.querySelector('.base-price').value);
      const vat        = cleanNum(item.querySelector('.vat-value').value);

      // จัดรูปแบบวันที่มาตรฐาน YYYY-MM-DD
      let formattedDate = "0000-00-00";
      if (rawDate) {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) formattedDate = d.toISOString().split('T')[0];
      }

      const storageDate = (formattedDate !== "0000-00-00") 
        ? formattedDate 
        : new Date().toISOString().split('T')[0];


      const [year, month, day] = formattedDate.split('-');
      const shopName = getUnifiedShopName(rawShop);
      const supplierName = rawSup || "Unknown";
      const invNo = rawDocNo || "NO-IV";

      // 1. อัปโหลดไฟล์แนบตรงเข้า Firebase Storage (ไม่ต้องแปลง Base64)
      const fileInput = item.querySelector('.invoice-file');
      const uploadedUrls = [];

      if (fileInput && fileInput.files.length > 0) {
        for (let i = 0; i < fileInput.files.length; i++) {
          const file = fileInput.files[i];
          const ext = file.name.split('.').pop();

          btnSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังอัปโหลดไฟล์รายการที่ ${index + 1} (${i + 1}/${fileInput.files.length})...`;

          const finalFileName = `${invNo}_${supplierName}_${netAmount}_${i + 1}.${ext}`;
          const storagePath = `invoice_library/${shopName}/${year}/${month}/${day}/${finalFileName}`;
          const storageRef = ref(storage, storagePath);

          // อัปโหลดไฟล์ตรงและดึง Download URL
          const snapshot = await uploadBytes(storageRef, file);
          const downloadUrl = await getDownloadURL(snapshot.ref);
          uploadedUrls.push(downloadUrl);
        }
      }

      // 2. เตรียมข้อมูลบันทึกลง Collection 'expense' ตามโครงสร้างเดิม 100%
      btnSubmit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึกข้อมูลลง Firestore...`;

      const firestorePayload = {
        doc_no:       "",
        invoice_no:   rawDocNo,
        doc_date:     formattedDate,
        list:         rawList,
        supplier:     supplierName,
        shop:         shopName,
        net_amount:   netAmount,
        total_amount: netAmount,
        non_vat:      nonVat,
        ex_vat:       exVat,
        vat:          vat,
        url:          uploadedUrls.join("\n"),
        status:       "done",
        clam_sub:     "false",
        paid:         "false",
        timestamp:    new Date().toISOString()
      };

      const docId = `${formattedDate}_${safeId(shopName)}_${safeId(supplierName)}_${netAmount.toFixed(2)}`;
      const expenseRef = doc(db, "expense", docId);

      // เพิ่มเข้า Batch Write (merge: true เทียบเท่า updateMask ใน GAS)
      batch.set(expenseRef, firestorePayload, { merge: true });
      savedSummaryList.push({ shop: shopName, net_amount: netAmount });
    }

    // 3. สั่งบันทึกทุกใบลง Firestore พร้อมกัน
    await batch.commit();

    // 4. บันทึก Audit Log พร้อมชื่อพนักงานที่ล็อกอินจริง
    const totalAmt = savedSummaryList.reduce((sum, item) => sum + item.net_amount, 0);
    const firstShop = savedSummaryList.length > 0 ? savedSummaryList[0].shop : "Unknown";
    await insertAuditLog(
      "BULK_SAVE",
      `บันทึกบิลชุดใหม่ (${savedSummaryList.length} รายการ) ร้าน ${firstShop} ยอดรวม ${totalAmt.toFixed(2)} บาท`,
      window.currentUser
    );

    // 5. แสดง Modal บันทึกสำเร็จ
    const modalElement = document.getElementById('successModal');
    if (modalElement) {
      const myModal = new bootstrap.Modal(modalElement);
      myModal.show();
    } else {
      alert('บันทึกข้อมูลสำเร็จเรียบร้อยแล้ว');
    }

  } catch (error) {
    console.error("❌ เกิด Error ใน submitAllData:", error);
    alert("เกิดข้อผิดพลาดในการบันทึกข้อมูล: " + error.message);
  } finally {
    isProcessing = false;
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = originalBtnHtml;
  }
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function getUnifiedShopName(rawName) {
  return String(rawName || "").trim().replace(/\s+/g, "_");
}

function safeId(txt) {
  return String(txt || "").trim().replace(/\s+/g, '_').replace(/\//g, '-');
}

function cleanNum(val) {
  if (!val) return 0;
  const n = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : Number(val);
  return isNaN(n) ? 0 : n;
}

function escapeHtml(str) {
  return String(str)
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

// ============================================================================
// 🔗 ผูกฟังก์ชันเข้า window เพื่อให้ HTML เรียกใช้ผ่าน onclick/onchange ได้
// ============================================================================
window.saveNewSupplierMaster = saveNewSupplierMaster;
window.saveNewListMaster = saveNewListMaster;
window.addNew = addNew;
window.toggleVatDisplay = toggleVatDisplay;
window.calculateVat = calculateVat;
window.validateFileLimit = validateFileLimit;
window.addNewInvoiceBlock = addNewInvoiceBlock;
window.removeInvoice = removeInvoice;
window.startNewEntry = startNewEntry;
window.submitAllData = submitAllData;