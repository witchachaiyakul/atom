// public/js/claim.js
import { db, insertAuditLog } from "../../js/firestore.js";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  query, 
  where, 
  writeBatch 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

window.currentUser = null;
let selectedRows = [];
let selectedPaymentRows = [];
let allUnclaimedData = [];
let currentPreviewDocNo = "";
let isSavingClaim = false;

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("ExpenseForm2")) return;

  // ใส่ ?. ป้องกัน Error กรณีหน้า claim.html ใช้ปุ่มกลับหน้าหลักแทนปุ่มออกจากระบบ
  document.getElementById("btnLogout")?.addEventListener("click", handleLogout);

  try {
    await Promise.all([
      loadShopDatalist(),
      loadUnclaimedExpenses()
    ]);
  } catch (err) {
    console.error("โหลดข้อมูลหน้าตั้งเบิกล้มเหลว:", err);
  }
});

function verifyPageAccess(requiredOption = "ExpenseForm2") {
  const rawUser = sessionStorage.getItem("atom_line_user");
  if (!rawUser) {
    window.location.href = "../login.html";
    return false;
  }

  try {
    const user = JSON.parse(rawUser);
    const role = (user.role || "").toLowerCase();

    // รองรับทั้ง Array และ String ป้องกัน Error จาก .map()
    const rawOptions = Array.isArray(user.allowedOptions)
      ? user.allowedOptions
      : String(user.allowedOptions || "").split(",").map(s => s.trim()).filter(Boolean);

    const allowedList = rawOptions.map(opt => opt.toLowerCase());
    const targetOpt = String(requiredOption || "").toLowerCase();

    const hasAccess = role === "admin" || 
                      allowedList.includes("all") || 
                      allowedList.includes(targetOpt);

    if (!hasAccess) {
      alert(`❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าตั้งเบิกค่าใช้จ่าย (ต้องการสิทธิ์: ${requiredOption})`);
      window.location.href = "index.html";
      return false;
    }

    window.currentUser = user;

    // ตรวจสอบว่ามี Element ในหน้า claim.html จริงก่อนกำหนดค่า
    const nameEl = document.getElementById("headerUserName");
    const roleEl = document.getElementById("headerUserRole");
    const imgEl = document.getElementById("headerUserImg");
    const profileBox = document.getElementById("userHeaderProfile");

    if (nameEl) nameEl.textContent = user.name || "ผู้ใช้งาน";
    if (roleEl) roleEl.textContent = user.role || "staff";
    if (imgEl && user.picture) imgEl.src = user.picture;
    if (profileBox) {
      profileBox.classList.remove("d-none");
      profileBox.classList.add("d-flex");
    }

    return true;
  } catch (err) {
    console.error("verifyPageAccess Error:", err);
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
// 📦 2. โหลดรายชื่อร้านค้า & รายการที่ยังไม่ตั้งเบิก (แทน getPendingClaims)
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

async function loadUnclaimedExpenses() {
  const area = document.getElementById('claimListArea');
  const summary = document.getElementById('summaryArea');

  area.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div><p class="mt-2">กำลังดึงข้อมูลจากระบบ...</p></div>';
  if (summary) summary.classList.add('d-none');
  selectedRows = [];
  selectedPaymentRows = [];
  updateShopBreakdown();

  try {
    const q = query(collection(db, "expense"), where("doc_no", "==", ""));
    const querySnapshot = await getDocs(q);

    const results = [];
    querySnapshot.forEach((docSnap) => {
      const f = docSnap.data();
      // ตัวกรองขั้นเด็ดขาด: ถ้า clam_sub เป็น "true" หรือ true ให้ข้ามทันที
      if (f.clam_sub === "true" || f.clam_sub === true) return;

      results.push({
        docId:      docSnap.id,
        supplier:   f.supplier || "ไม่ระบุ",
        amount:     parseFloat(f.net_amount) || 0,
        date:       f.doc_date ? f.doc_date.split('-').reverse().join('/') : "-",
        invoice_no: f.invoice_no || "-",
        doc_date:   f.doc_date || "-",
        list:       f.list || "-",
        shop:       f.shop || "-",
        net_amount: parseFloat(f.net_amount) || 0,
        doc_no:     f.doc_no || "",
        vat:        parseFloat(f.vat) || 0,
        ex_vat:     parseFloat(f.ex_vat) || 0,
        url:        f.url || "",
        non_vat:    parseFloat(f.non_vat) || 0,
        clam_sub:   f.clam_sub || ""
      });
    });

    // เรียงลำดับตาม doc_date จากใหม่ไปเก่า (DESCENDING)
    results.sort((a, b) => (b.doc_date || "").localeCompare(a.doc_date || ""));
    allUnclaimedData = results;

    if (results.length === 0) {
      area.innerHTML = '<div class="alert alert-info text-center m-3">ไม่พบรายการค้างตั้งเบิก</div>';
      document.getElementById('searchCount').innerText = "พบทั้งหมด 0 รายการ";
      return;
    }

    let html = `
      <div class="table-responsive bg-white">
        <table class="table table-sm table-hover mb-0" id="mainClaimTable">
          <thead class="table-light sticky-top">
            <tr>
              <th class="text-center">เลือก</th>
              <th>วันที่</th>
              <th>Supplier / ร้านค้า</th>
              <th>รายการ</th>
              <th class="text-center">URL</th>
              <th class="text-end">จำนวนเงิน</th>
            </tr>
          </thead>
          <tbody>`;

    results.forEach((item) => {
      const itemJson = JSON.stringify(item).replace(/'/g, "&apos;");
      let urlHtml = '<span class="text-muted small">-</span>';
      if (item.url && item.url.trim() !== "") {
        const urls = item.url.split('\n');
        urlHtml = urls.map((u, i) => 
          `<a href="${escapeHtml(u.trim())}" target="_blank" class="btn btn-xs btn-outline-primary py-0 px-1 me-1" title="ดูไฟล์ที่ ${i + 1}">
            <i class="bi bi-link-45deg"></i>
          </a>`
        ).join('');
      }

      html += `
        <tr class="claim-row" 
            data-supplier="${escapeHtml((item.supplier || "").toLowerCase())}" 
            data-shop="${escapeHtml((item.shop || "").toLowerCase())}"
            data-amount="${item.amount}"
            data-item='${itemJson}'> 
          <td class="text-center">
            <input type="checkbox" class="form-check-input row-chk" 
                   onchange='toggleItem(${itemJson})'>
          </td>
          <td class="small">${escapeHtml(item.date || '-')}</td>
          <td>
            <div class="fw-bold text-success">${escapeHtml(item.supplier || '-')}</div>
            <div class="small text-primary">${escapeHtml(item.shop || '-')}</div>
          </td>
          <td class="small">${escapeHtml(item.list || '-')}</td>
          <td class="text-center">${urlHtml}</td>
          <td class="text-end fw-bold">${Number(item.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    area.innerHTML = html;
    filterClaimList();

  } catch (error) {
    console.error("❌ โหลดรายการค้างตั้งเบิกล้มเหลว:", error);
    area.innerHTML = `<div class="alert alert-danger m-3">เกิดข้อผิดพลาดในการโหลดข้อมูล: ${escapeHtml(error.message)}</div>`;
  }
}

// ============================================================================
// 🔍 3. ตัวกรอง & คำนวณยอดรายการที่เลือก
// ============================================================================
function filterClaimList() {
  const sSupplier = document.getElementById('claimSearchSupplier').value.toLowerCase().trim();
  const sShop = document.getElementById('claimSearchShop').value.toLowerCase().trim();
  const sAmount = document.getElementById('claimSearchAmount').value.replace(/,/g, '').trim(); 
  
  const rows = document.querySelectorAll('.claim-row');
  let visibleCount = 0;

  rows.forEach(row => {
    const tSupplier = (row.getAttribute('data-supplier') || "").toLowerCase();
    const tShop = (row.getAttribute('data-shop') || "").toLowerCase();
    const tAmount = (row.getAttribute('data-amount') || "").replace(/,/g, ''); 

    const matchSupplier = sSupplier === "" || tSupplier.includes(sSupplier);

    let matchShop = false;
    if (sShop === "") {
      matchShop = true;
    } else if (sShop === "atom") {
      matchShop = (tShop === "atom");
    } else {
      matchShop = tShop.includes(sShop);
    }

    const matchAmount = sAmount === "" || tAmount.includes(sAmount);
    const isMatch = matchSupplier && matchShop && matchAmount;
    row.style.display = isMatch ? "" : "none";
    if (isMatch) visibleCount++;
  });

  const searchCountEl = document.getElementById('searchCount');
  if (searchCountEl) searchCountEl.innerText = `พบทั้งหมด ${visibleCount} รายการ`;

  const area = document.getElementById('claimListArea');
  let noResultMsg = document.getElementById('noResultMsg');

  if (visibleCount === 0) {
    if (!noResultMsg) {
      const div = document.createElement('div');
      div.id = 'noResultMsg';
      div.className = 'text-center py-5 text-muted';
      div.innerHTML = '<i class="bi bi-search fs-2"></i><p class="mt-2">ไม่พบรายการที่ตรงกับเงื่อนไข</p>';
      area.appendChild(div);
    }
  } else if (noResultMsg) {
    noResultMsg.remove();
  }
}

function selectAllVisible(status) {
  const isChecked = !!status;
  const rows = document.querySelectorAll('.claim-row');
  
  rows.forEach(row => {
    const isVisible = row.offsetWidth > 0 && row.offsetHeight > 0;
    if (isVisible) {
      const chk = row.querySelector('.row-chk');
      if (chk && chk.checked !== isChecked) {
        const dataStr = row.getAttribute('data-item');
        if (dataStr) {
          try {
            const itemData = JSON.parse(dataStr);
            if (itemData && itemData.docId) { 
              chk.checked = isChecked;
              toggleItem(itemData);
            }
          } catch (e) {
            console.error("❌ JSON Parse Error:", e);
          }
        }
      }
    }
  });
}

function toggleItem(item) {
  const idx = selectedRows.findIndex(r => r.docId === item.docId);
  if (idx > -1) {
    selectedRows.splice(idx, 1);
  } else {
    selectedRows.push(item);
  }
  updateShopBreakdown();
}

function updateShopBreakdown() {
  const summaryArea = document.getElementById('summaryArea');
  const totalEl = document.getElementById('totalClaimAmount');
  const breakdownList = document.getElementById('shopBreakdownList');

  if (!selectedRows || selectedRows.length === 0) {
    if (summaryArea) summaryArea.classList.add('d-none');
    if (totalEl) totalEl.innerText = "0.00";
    if (breakdownList) breakdownList.innerHTML = '';
    return;
  }

  if (summaryArea) summaryArea.classList.remove('d-none');

  let grandTotal = 0;
  const shopMap = selectedRows.reduce((acc, r) => {
    const amt = parseFloat(r.amount || r.net_amount || 0);
    grandTotal += amt;
    const shopName = getDisplayShopName(r.shop || 'ไม่ระบุร้าน');
    acc[shopName] = (acc[shopName] || 0) + amt;
    return acc;
  }, {});

  if (totalEl) {
    totalEl.innerText = grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (breakdownList) {
    const shops = Object.keys(shopMap);
    breakdownList.innerHTML = shops.map(shop => `
      <div class="badge bg-white text-dark border border-primary p-2 shadow-sm me-2 mb-2">
        <span class="text-primary fw-bold">${escapeHtml(shop)}:</span> 
        <span>${shopMap[shop].toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
      </div>
    `).join('');
  }
}

// ============================================================================
// 📄 4. ยืนยันและเตรียมหน้า Preview พิมพ์ใบตั้งเบิก
// ============================================================================
function handleSaveBulk() {
  selectedRows = []; 
  const checkedBoxes = document.querySelectorAll('.row-chk:checked');
  
  checkedBoxes.forEach(cb => {
    const row = cb.closest('tr'); 
    if (row && row.getAttribute('data-item')) {
      try {
        const item = JSON.parse(row.getAttribute('data-item'));
        selectedRows.push(item); 
      } catch (e) { 
        console.error("ไม่สามารถอ่านข้อมูลรายการได้:", e); 
      }
    }
  });

  if (selectedRows.length === 0) {
    alert("กรุณาเลือกอย่างน้อย 1 รายการเพื่อตั้งเบิก");
    return;
  }

  const countEl = document.getElementById('confirmCount');
  const totalEl = document.getElementById('confirmTotal');
  const screenTotal = document.getElementById('totalClaimAmount');

  if (countEl) countEl.innerText = selectedRows.length;
  if (totalEl && screenTotal) totalEl.innerText = screenTotal.innerText;

  const modalEl = document.getElementById('confirmBulkModal');
  if (modalEl) {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }
}

async function executeSaveBulk() {
  const modalEl = document.getElementById('confirmBulkModal');
  const modal = bootstrap.Modal.getInstance(modalEl);
  if (modal) modal.hide();

  if (!selectedRows || selectedRows.length === 0) {
    if (selectedPaymentRows && selectedPaymentRows.length > 0) {
      selectedRows = [...selectedPaymentRows];
    }
  }

  if (selectedRows.length === 0) {
    alert("กรุณาเลือกรายการที่ต้องการตั้งเบิก");
    return;
  }

  const itemsToPreview = [...selectedRows]; 
  selectedPaymentRows = [...selectedRows];

  const previewContent = document.getElementById('previewContent');
  if (previewContent) {
    previewContent.innerHTML = '<div class="text-center p-5"><div class="spinner-border text-primary"></div><p class="mt-2">กำลังเตรียมข้อมูลและรันเลขที่เอกสาร...</p></div>';
  }

  const previewModalEl = document.getElementById('previewPrintModal');
  const previewModal = new bootstrap.Modal(previewModalEl);
  previewModal.show();

  try {
    const supplierId = itemsToPreview[0].supplier;

    const [nextNo, supDetails] = await Promise.all([
      generateDocNo(),
      getSupplierDetails(supplierId)
    ]);

    currentPreviewDocNo = nextNo;
    const finalDetails = supDetails || { name: supplierId || "-", supplier_address: "-", supplier_tax_id: "-" };

    itemsToPreview.forEach(row => {
      row.name = finalDetails.name || row.supplier || "-";
      row.supplier_address = finalDetails.supplier_address || "-";
      row.supplier_tax_id = finalDetails.supplier_tax_id || "-";
    });

    preparePrintPreview(currentPreviewDocNo, itemsToPreview);

    const printAreaEl = document.getElementById('printArea');
    if (printAreaEl && previewContent) {
      previewContent.innerHTML = printAreaEl.innerHTML;
    }

  } catch (err) {
    console.error("❌ เตรียมหน้า Preview ล้มเหลว:", err);
    previewModal.hide();
    alert("ไม่สามารถเตรียมหน้า Preview ได้: " + err.message);
  }
}

async function getSupplierDetails(supplierIdOrName) {
  if (!supplierIdOrName) return { name: "-", supplier_address: "-", supplier_tax_id: "-", supplier: "-" };
  try {
    const supRef = doc(db, "supplier", supplierIdOrName);
    const supSnap = await getDoc(supRef);
    if (!supSnap.exists()) {
      return { name: supplierIdOrName, supplier_address: "-", supplier_tax_id: "-", supplier: supplierIdOrName };
    }
    const f = supSnap.data();
    return {
      name: f.name || supplierIdOrName,
      supplier_address: f.address || "-",
      supplier_tax_id: f.tax_id || "-",
      supplier: f.supplier || supplierIdOrName
    };
  } catch (e) {
    console.error("Error fetching supplier:", e);
    return { name: supplierIdOrName, supplier_address: "-", supplier_tax_id: "-", supplier: supplierIdOrName };
  }
}

async function generateDocNo() {
  const now = new Date();
  const month = ("0" + (now.getMonth() + 1)).slice(-2);
  const yearShort = now.getFullYear().toString().slice(-2); 
  const currentPrefix = "EXP" + month + yearShort;

  const docRef = doc(db, "explog", "expense_doc_no");
  const snap = await getDoc(docRef);

  let nextNum = 1;
  if (snap.exists()) {
    const data = snap.data();
    const lastPrefix = data.last_prefix || "";
    const lastNumber = parseInt(data.last_number || 0, 10);
    nextNum = (lastPrefix === currentPrefix) ? (lastNumber + 1) : 1;
  }

  const newDocNo = currentPrefix + nextNum.toString().padStart(4, '0');

  await setDoc(docRef, {
    last_number: nextNum,
    last_prefix: currentPrefix
  }, { merge: true });

  return newDocNo;
}

function preparePrintPreview(docNo, items) {
  const docNoEl = document.getElementById('printDocNo');
  if (docNoEl) docNoEl.innerText = docNo;

  const today = new Date();
  const dateEl = document.getElementById('printDate');
  if (dateEl) dateEl.innerText = `${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear() + 543}`;

  const supInfo = items[0] || {};
  if (document.getElementById('printSupplier')) {
    document.getElementById('printSupplier').innerText = 
      supInfo.name || supInfo.supplier_full_name || getDisplayShopName(supInfo.shop) || "-";
  }
  if (document.getElementById('printSupplierAddress')) 
    document.getElementById('printSupplierAddress').innerText = supInfo.supplier_address || "-";
  if (document.getElementById('printSupplierTaxId')) 
    document.getElementById('printSupplierTaxId').innerText = supInfo.supplier_tax_id || "-";

  let html = "";
  let total = 0;
  let sumVat = 0;
  let sumNonVat = 0;
  let sumHasVat = 0; 

  items.forEach((it) => {
    const netAmt = parseFloat(it.amount || it.net_amount || 0);
    const v = parseFloat(it.vat || 0);
    
    total += netAmt;
    sumVat += v;

    if (v > 0) {
      sumHasVat += (netAmt - v); 
    } else {
      sumNonVat += netAmt; 
    }

    html += `
      <tr style="border-bottom: 1px solid #000;">
        <td class="text-center p-1">${escapeHtml(it.invoice_no || '-')}</td>
        <td class="text-center p-1">${formatThaiDate(it.doc_date || it.date)}</td>
        <td class="p-1">${escapeHtml(it.list || '-')}</td>
        <td class="text-center p-1">${escapeHtml(getDisplayShopName(it.shop))}</td>
        <td class="text-end p-1">${netAmt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td class="p-1"></td>
      </tr>`;
  });
  
  const tableBody = document.getElementById('printTableBody');
  if (tableBody) tableBody.innerHTML = html;

  if (document.getElementById('sumNonVat')) 
    document.getElementById('sumNonVat').innerText = sumNonVat.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (document.getElementById('sumHasVat')) 
    document.getElementById('sumHasVat').innerText = sumHasVat.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (document.getElementById('totalVat')) 
    document.getElementById('totalVat').innerText = sumVat.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (document.getElementById('printTotalAmount'))
    document.getElementById('printTotalAmount').innerText = total.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (document.getElementById('printAmountText'))
    document.getElementById('printAmountText').innerText = ArabicToThaiBaht(total);

  const shopMap = items.reduce((acc, r) => {
    const shopName = getDisplayShopName(r.shop || 'ไม่ระบุร้าน');
    acc[shopName] = (acc[shopName] || 0) + parseFloat(r.amount || r.net_amount || 0);
    return acc;
  }, {});

  let shopHtml = "";
  for (const shop in shopMap) {
    shopHtml += `
      <tr>
        <td class="p-1">${escapeHtml(shop)}</td>
        <td class="text-end p-1">${shopMap[shop].toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      </tr>`;
  }
  const shopBody = document.getElementById('shopSummaryBody');
  if (shopBody) shopBody.innerHTML = shopHtml;
}

// ============================================================================
// 🖨️ 5. บันทึกสถานะตั้งเบิกและสั่งพิมพ์ (แทน finalPrint + confirmAndSaveClaim)
// ============================================================================
async function finalPrint() {
  if (isSavingClaim) return;

  const docNo = currentPreviewDocNo;
  if (!docNo) {
    alert("ไม่พบเลขที่เอกสารสำหรับบันทึก กรุณาเริ่มรายการใหม่");
    return;
  }

  let itemsToSave = [];
  if (selectedRows && selectedRows.length > 0) {
    itemsToSave = selectedRows;
  } else if (selectedPaymentRows && selectedPaymentRows.length > 0) {
    itemsToSave = selectedPaymentRows;
  }

  if (!itemsToSave || itemsToSave.length === 0) {
    alert("⚠️ ไม่พบรายการบิลที่เลือกในระบบ กรุณาปิดหน้าต่างนี้แล้วติ๊กเลือกบิลบนตารางใหม่อีกครั้งครับ");
    return;
  }

  isSavingClaim = true;
  const printBtn = document.querySelector('#previewPrintModal .btn-success');
  const originalBtnHtml = printBtn ? printBtn.innerHTML : "";
  if (printBtn) {
    printBtn.disabled = true;
    printBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก...`;
  }

  try {
    // อัปเดตเอกสารใน collection 'expense' ทั้งหมดที่เลือกด้วย Batch Write
    const batch = writeBatch(db);
    let updatedCount = 0;

    itemsToSave.forEach((item) => {
      if (!item.docId) return;
      const expenseRef = doc(db, "expense", item.docId);
      batch.set(expenseRef, {
        doc_no:   docNo,
        clam_sub: "true",
        status:   "claimed"
      }, { merge: true });
      updatedCount++;
    });

    await batch.commit();

    // บันทึก Audit Log พร้อมชื่อพนักงานที่กดตั้งเบิกจริง
    await insertAuditLog(
      "CLAIM_SAVE",
      `ตั้งเบิกรายการจำนวน ${updatedCount} รายการ เลขเอกสาร: ${docNo}`,
      window.currentUser
    );

    // สั่งเปิดหน้าต่างพิมพ์ของเบราว์เซอร์
    window.print();

    // ปิด Modal Preview
    const previewModalEl = document.getElementById('previewPrintModal');
    if (previewModalEl) {
      const modal = bootstrap.Modal.getInstance(previewModalEl);
      if (modal) modal.hide();
    }

    // แสดงแจ้งเตือนและรีเฟรชรายการค้างตั้งเบิก
    showToast(`บันทึกใบตั้งเบิกเลขที่ ${docNo} สำเร็จแล้ว`, "success");
    showSuccessAfterPrint(docNo);

  } catch (err) {
    console.error("❌ Error in finalPrint:", err);
    alert("เกิดข้อผิดพลาดขณะบันทึก: " + err.message);
  } finally {
    isSavingClaim = false;
    if (printBtn) {
      printBtn.disabled = false;
      printBtn.innerHTML = originalBtnHtml;
    }
  }
}

function showSuccessAfterPrint(docNo) {
  selectedRows = [];
  selectedPaymentRows = [];
  currentPreviewDocNo = ""; 

  if (document.getElementById('summaryArea')) {
    document.getElementById('summaryArea').classList.add('d-none');
  }

  updateShopBreakdown();
  loadUnclaimedExpenses();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  console.log("✅ บันทึกเลขที่เอกสาร " + docNo + " สำเร็จ");
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

function formatThaiDate(dateStr) {
  if (!dateStr || dateStr === "-" || dateStr === "0000-00-00") return "-";
  if (dateStr.includes("-")) {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const thaiYear = y < 2400 ? y + 543 : y;
      return `${parts[2]}/${parts[1]}/${thaiYear}`;
    }
  }
  return dateStr;
}

function ArabicToThaiBaht(number) {
  const num = parseFloat(number);
  if (isNaN(num) || num === 0) return "ศูนย์บาทถ้วน";
  const txtNum = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
  const txtDigit = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];
  const parts = num.toFixed(2).split(".");
  
  const convertPart = (str) => {
    let res = "";
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const n = parseInt(str[i], 10);
      const pos = len - i - 1;
      if (n !== 0) {
        if (pos % 6 === 1 && n === 1) res += "";
        else if (pos % 6 === 1 && n === 2) res += "ยี่";
        else if (pos % 6 === 0 && n === 1 && len > 1 && str[i - 1] !== "0") res += "เอ็ด";
        else res += txtNum[n];
        res += txtDigit[pos % 6];
      }
      if (pos !== 0 && pos % 6 === 0) res += "ล้าน";
    }
    return res;
  };

  let bahtText = parts[0] === "0" ? "" : convertPart(parts[0]) + "บาท";
  if (parts[1] === "00") {
    bahtText += "ถ้วน";
  } else {
    bahtText += convertPart(parts[1]) + "สตางค์";
  }
  return bahtText;
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
window.loadUnclaimedExpenses = loadUnclaimedExpenses;
window.filterClaimList = filterClaimList;
window.selectAllVisible = selectAllVisible;
window.toggleItem = toggleItem;
window.handleSaveBulk = handleSaveBulk;
window.executeSaveBulk = executeSaveBulk;
window.finalPrint = finalPrint;