// public/js/income.js
import { db, storage, insertAuditLog } from "./firestore.js";
import { 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  addDoc,
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  ref, 
  uploadBytesResumable, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

window.currentUser = null;
let allIncomes = [];
let filteredIncomes = [];
let currentIncomeData = null;
let isSavingIncome = false;

const TARGET_STORES = [
  "Atom",
  "Atom_Beach",
  "Good_Time",
  "Paradise",
  "Tiger_King_Bar_&_Bistro"
];

// ============================================================================
// 🚀 1. เริ่มต้นทำงานและตรวจสอบสิทธิ์
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (!verifyPageAccess("IncomeForm")) return;

  document.getElementById("btnLogout").addEventListener("click", handleLogout);

  // ✅ ตั้งค่าช่องกรองวันที่เริ่มต้นเป็น "วันที่ปัจจุบัน" (YYYY-MM-DD ตามเวลาท้องถิ่น)
  const dateFilterEl = document.getElementById("incomeFilterDate");
  if (dateFilterEl && !dateFilterEl.value) {
    const now = new Date();
    const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split("T")[0];
    dateFilterEl.value = localToday;
  }

  populateShopDatalist();
  await loadAllIncomes(); // เมื่อโหลดเสร็จ ระบบจะเรียก filterIncomeTable() และกรองตามวันที่ปัจจุบันทันที
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
      alert("❌ คุณไม่มีสิทธิ์เข้าใช้งานหน้าบันทึกรายรับรายวัน");
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

function populateShopDatalist() {
  const dl = document.getElementById("shopList");
  if (!dl) return;
  dl.innerHTML = TARGET_STORES
    .map(storeId => `<option value="${escapeHtml(getDisplayShopName(storeId))}">`)
    .join("");
}

// ============================================================================
// 📦 2. ดึงข้อมูลรายรับรายวันจาก Firestore (income/{storeId}/daily_records)
// ============================================================================
async function loadAllIncomes() {
  const container = document.getElementById("incomeListContainer");
  if (container) {
    container.innerHTML = `
      <div class="text-center py-5">
        <div class="spinner-border text-primary"></div>
        <p class="mt-2 mb-0 text-muted">กำลังดึงข้อมูลรายรับจากทุกสาขา...</p>
      </div>`;
  }

  try {
    // ดึงข้อมูลทั้ง 5 ร้านแบบขนาน (Parallel) เพื่อความรวดเร็ว
    const storePromises = TARGET_STORES.map(async (storeId) => {
      const recordsCol = collection(db, "income", storeId, "daily_records");
      const snap = await getDocs(recordsCol);
      return snap.docs.map(docSnap => ({
        storeId,
        docId: docSnap.id,
        data: docSnap.data()
      }));
    });

    const nestedResults = await Promise.all(storePromises);
    const flatDocs = nestedResults.flat();

    const getNum = (val) => {
      if (val === undefined || val === null || val === "") return 0;
      const parsed = Number(val);
      return isNaN(parsed) ? 0 : parsed;
    };

    allIncomes = flatDocs.map((entry, index) => {
      const f = entry.data || {};
      const docId = entry.docId;
      const storeId = entry.storeId;
      const shopDisplay = getDisplayShopName(storeId);

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
        docId:         docId,
        storeId:       storeId,
        row:           index + 2,
        dateRaw:       docId,
        dateShow:      docId,
        shop:          shopDisplay,
        cash:          ochaSummary.Cash,
        visa:          ochaSummary.VISA,
        mastercard:    ochaSummary.Mastercard,
        bank_transfer: ochaSummary["Bank Transfer"],
        other_ocha:    ochaSummary.Other,
        total_amount:  ochaSummary["Total Amount Collected"],
        cash_out:      getNum(f.cash_out),
        tip:           getNum(f.tip),
        tip_type:      f.tip_type || "-",
        other_exp:     getNum(f.other_exp),
        net_cash:      getNum(f.net_cash),
        status:        f.status || "",
        adj_visa:      getNum(f.adj_visa),
        adj_master:    getNum(f.adj_master),
        adj_transfer:  getNum(f.adj_transfer),
        adj_cash:      getNum(f.adj_cash),
        totalIncome:   getNum(f.net_cash),
        totalL:        ochaSummary["Total Amount Collected"]
      };
    }).sort((a, b) => b.dateRaw.localeCompare(a.dateRaw));

    filterIncomeTable();

  } catch (err) {
    console.error("❌ loadAllIncomes Error:", err);
    if (container) {
      container.innerHTML = `<div class="p-4 text-center text-danger">เกิดข้อผิดพลาดในการโหลดข้อมูล: ${escapeHtml(err.message)}</div>`;
    }
    showToast("เกิดข้อผิดพลาด: " + err.message, "danger");
  }
}

// ============================================================================
// 🔍 3. กรองข้อมูลและวาดรายการรายรับรายวัน
// ============================================================================
function filterIncomeTable() {
  const fDateEl = document.getElementById('incomeFilterDate');
  const fShopEl = document.getElementById('incomeFilterShop');
  
  const fDate = fDateEl ? fDateEl.value.trim() : ""; 
  const fShop = fShopEl ? fShopEl.value.toLowerCase().trim() : "";

  closeIncomeEdit();

  const filtered = (allIncomes || []).filter(i => {
    const itemDate = (i.dateRaw || "").trim();
    const rawShop = (i.shop || i.storeId || "").toString().trim();
    const displayShop = getDisplayShopName(rawShop).toLowerCase();
    const normalizedShop = rawShop.toLowerCase().replace(/_/g, ' ');
    
    // 1. กรองตามวันที่
    const matchDate = fDate ? (itemDate === fDate) : true;
    
    // 2. กรองตามชื่อร้าน (แยก Atom ออกจาก Atom Beach เด็ดขาด)
    let matchShop = true;
    if (fShop !== "") {
      if (fShop === "atom") {
        matchShop = (normalizedShop === "atom" || displayShop === "atom");
      } else {
        matchShop = (
          normalizedShop.includes(fShop) || 
          displayShop.includes(fShop) || 
          fShop.replace(/_/g, ' ').includes(normalizedShop)
        );
      }
    }
    
    return matchDate && matchShop;
  });

  renderIncomeTable(filtered);
}

function renderIncomeTable(data) {
  const container = document.getElementById('incomeListContainer');
  if (!container) return;
  filteredIncomes = data; 

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="p-4 text-center text-muted">ไม่พบข้อมูลรายรับ</div>';
    return;
  }

  container.innerHTML = data.map((i, index) => {
    const netCashVal = parseFloat(i.net_cash || 0);
    const isSaved = i.status === "done";
    
    let badgeHtml = '';
    if (!isSaved) {
      badgeHtml = `<span class="badge bg-warning text-dark p-2" style="font-size: 0.9rem;"><i class="bi bi-exclamation-triangle"></i> ยังไม่บันทึก</span>`;
    } else if (netCashVal === 0) {
      badgeHtml = `<span class="badge bg-warning text-danger p-2 fw-bold" style="font-size: 0.9rem;"><i class="bi bi-exclamation-triangle"></i> ยังไม่ได้บันทึก Cash Out</span>`;
    } else {
      badgeHtml = `<span class="badge bg-primary fs-5 py-2 px-3 fw-bold">${netCashVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>`;
    }

    const totalSales = parseFloat(i.total_amount || 0);
    const ochaCash = parseFloat(i.cash || 0);

    return `
      <button type="button" onclick="handleSelectIncome(${index})" class="list-group-item list-group-item-action py-3">
        <div class="d-flex justify-content-between align-items-center">
          <div>
            <strong class="text-primary fs-5">${escapeHtml(i.shop)}</strong> 
            <span class="ms-2 small text-muted">${escapeHtml(i.dateShow)}</span>
          </div>
          <div class="text-end">
            <small class="d-block text-muted fw-bold" style="font-size: 0.8rem;">เงินสดสุทธิ (Net Cash)</small>
            ${badgeHtml}
          </div>
        </div>
        <div class="small mt-2 text-muted border-top pt-1">
          เงินสด Ocha: <strong>${ochaCash.toLocaleString()}</strong> | 
          ยอดขายรวม (Ocha): <strong class="text-dark">${totalSales.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
        </div>
      </button>
    `;
  }).join('');
}

function handleSelectIncome(index) {
  const data = filteredIncomes[index];
  if (data) {
    selectIncomeRow(data);
  }
}

// ============================================================================
// ✏️ 4. เปิดฟอร์มแก้ไขและคำนวณยอดรายวัน
// ============================================================================
function selectIncomeRow(i) {
  currentIncomeData = i; 
  
  const editTitleEl = document.getElementById('editTitle');
  if (editTitleEl) {
    editTitleEl.innerHTML = `<i class="bi bi-shop"></i> ${escapeHtml(i.shop)} <span class="badge bg-white text-primary ms-2">วันที่ ${escapeHtml(i.dateShow)}</span>`;
  }

  const shopFormatted = standardizeShopNameFrontend(i.storeId || i.shop);
  const originalDocId = i.docId || `${shopFormatted}_${i.dateRaw}`;
  currentIncomeData.lockedDocId = originalDocId;

  const successSection = document.getElementById('saveSuccessSection');
  if (successSection) successSection.classList.add('d-none');

  const bulkStatus = document.getElementById('bulkUploadStatus');
  if (bulkStatus) bulkStatus.classList.add('d-none');
  
  const progressBar = document.getElementById('uploadProgress');
  if (progressBar) {
    progressBar.style.width = "0%";
    progressBar.classList.remove('bg-success', 'bg-danger', 'progress-bar-animated');
    progressBar.classList.add('bg-primary');
  }
  
  const fileInput = document.getElementById('cashoutFiles');
  if (fileInput) fileInput.value = "";

  const editSection = document.getElementById('incomeEditSection');
  if (editSection) {
    editSection.classList.remove('d-none');
    editSection.style.display = 'block';
  }

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isNumber = typeof val === 'number';
    const displayVal = (val !== undefined && val !== null && val !== "") ? val : (isNumber ? 0 : "-");

    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
      el.value = (displayVal === "-") ? "" : displayVal;
    } else {
      el.innerText = isNumber ? displayVal.toLocaleString(undefined, { minimumFractionDigits: 2 }) : displayVal;
    }
  };

  setVal('viewCash', i.cash);
  setVal('viewVisa', i.visa);
  setVal('viewMaster', i.mastercard || 0); 
  setVal('viewTransfer', i.bank_transfer || 0); 
  setVal('viewTotalL', i.total_amount || 0);
  setVal('viewOther', i.other_ocha || 0);

  setVal('inputCashout', i.cash_out || 0);
  setVal('inputTip', i.tip || 0);
  setVal('inputOther', i.other_exp || 0);

  const tType = i.tip_type || "";
  if (tType === "VISA") {
    document.getElementById('tipVisa').checked = true;
  } else if (tType === "MasterCard") {
    document.getElementById('tipMaster').checked = true;
  } else {
    const radios = document.getElementsByName('tipPaymentMethod');
    radios.forEach(r => r.checked = false);
  }

  const setAdjFields = (signId, valId, val) => {
    const signEl = document.getElementById(signId);
    const valEl = document.getElementById(valId);
    if (!signEl || !valEl) return;
    const num = parseFloat(val) || 0;
    signEl.value = num < 0 ? 'minus' : 'plus';
    valEl.value = Math.abs(num); 
  };
  
  setAdjFields('adjSignVisa', 'adjValVisa', i.adj_visa);
  setAdjFields('adjSignMaster', 'adjValMaster', i.adj_master);
  setAdjFields('adjSignTransfer', 'adjValTransfer', i.adj_transfer);
  setAdjFields('adjSignCash', 'adjValCash', i.adj_cash);

  setVal('viewCashOut', i.cash_out);
  setVal('viewTip', i.tip);
  setVal('viewTipType', i.tip_type);
  setVal('viewOtherIncome', i.other_exp);

  const statusEl = document.getElementById('viewRecordStatus');
  if (statusEl) {
    statusEl.innerHTML = i.status === "done" 
      ? '<span class="badge bg-success">บันทึกแล้ว</span>' 
      : '<span class="badge bg-warning text-dark">ยังไม่บันทึก</span>';
  }

  toggleTipType();
  calculateDiff();
  
  editSection.scrollIntoView({ behavior: 'smooth' });
}

function closeIncomeEdit() {
  document.getElementById('incomeEditSection')?.classList.add('d-none');
  document.getElementById('saveSuccessSection')?.classList.add('d-none');
  
  ['inputCashout', 'inputTip', 'inputOther', 'inputCashSum'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  
  ['adjValVisa', 'adjValMaster', 'adjValTransfer', 'adjValCash'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ['adjSignVisa', 'adjSignMaster', 'adjSignTransfer', 'adjSignCash'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "plus";
  });

  const diffEl = document.getElementById('displayDiff');
  if (diffEl) diffEl.innerText = "0.00";
  
  currentIncomeData = null;
}

function calculateDiff() {
  const getOchaVal = (id) => parseFloat(document.getElementById(id).innerText.replace(/,/g, '')) || 0;
  const ochaCash = getOchaVal('viewCash');
  const ochaVisa = getOchaVal('viewVisa');
  const ochaMaster = getOchaVal('viewMaster');
  const ochaTransfer = getOchaVal('viewTransfer');
  const ochaOther = getOchaVal('viewOther');

  const cashout = parseFloat(document.getElementById('inputCashout').value) || 0;
  const otherExp = parseFloat(document.getElementById('inputOther').value) || 0;
  const tip = parseFloat(document.getElementById('inputTip').value) || 0;

  const selectedTipRadio = document.querySelector('input[name="tipPaymentMethod"]:checked');
  const tipType = (tip > 0 && selectedTipRadio) ? selectedTipRadio.value : '-';

  const getAdj = (signId, valId) => {
    const sign = document.getElementById(signId).value === 'minus' ? -1 : 1;
    const val = parseFloat(document.getElementById(valId).value) || 0;
    return sign * val;
  };

  const adjVisa = getAdj('adjSignVisa', 'adjValVisa');
  const adjMaster = getAdj('adjSignMaster', 'adjValMaster');
  const adjTransfer = getAdj('adjSignTransfer', 'adjValTransfer');
  const adjCash = getAdj('adjSignCash', 'adjValCash');

  const tableVisa = ochaVisa + adjVisa;
  const tableMaster = ochaMaster + adjMaster;
  const tableTransfer = ochaTransfer + adjTransfer;
  const tableCash = ochaCash + adjCash; 
  
  const net_cash = tableCash - cashout - otherExp - tip; 
  const finalTotalRevenue = tableVisa + tableMaster + tableTransfer + tableCash + ochaOther;

  const setTableVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val.toLocaleString(undefined, { minimumFractionDigits: 2 });
  };
  
  setTableVal('adjViewCash', tableCash);
  setTableVal('adjViewVisa', tableVisa);
  setTableVal('adjViewMaster', tableMaster);
  setTableVal('adjViewTransfer', tableTransfer);
  setTableVal('adjViewOther', ochaOther);
  setTableVal('adjViewTotal', finalTotalRevenue);

  setTableVal('viewCashOut', cashout);
  setTableVal('viewTip', tip);
  setTableVal('viewOtherIncome', otherExp); 
  
  const viewTipTypeEl = document.getElementById('viewTipType');
  if (viewTipTypeEl) viewTipTypeEl.innerText = tipType;

  const setSummary = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val.toLocaleString(undefined, { minimumFractionDigits: 2 });
  };
  
  setSummary('finalVisa', tableVisa);
  setSummary('finalMaster', tableMaster);
  setSummary('finalTransfer', tableTransfer);
  setSummary('finalCash', net_cash);
  setSummary('displayDiff', net_cash);

  const cashEl = document.getElementById('finalCash');
  if (cashEl) {
    cashEl.className = (Math.abs(net_cash) < 0.01) ? "fs-2 fw-bold text-success" : "fs-2 fw-bold text-danger";
  }
}

function toggleTipType() {
  const tipInput = document.getElementById('inputTip');
  const tipValue = parseFloat(tipInput.value) || 0;
  const container = document.getElementById('tipTypeContainer');

  if (tipValue > 0) {
    container.classList.remove('d-none'); 
  } else {
    container.classList.add('d-none');    
  }
  calculateDiff(); 
}

// ============================================================================
// ☁️ 5. อัปโหลดบิล Cash Out เข้า Firebase Storage และส่งคิว OCR
// ============================================================================
async function startBulkUpload() {
  const fileInput = document.getElementById('cashoutFiles');
  const files = fileInput.files;
  const btn = document.getElementById('btnUploadBulk');
  const statusDiv = document.getElementById('bulkUploadStatus');
  const progressBar = document.getElementById('uploadProgress');
  const statusText = document.getElementById('statusText');

  if (files.length === 0) return alert("กรุณาเลือกไฟล์ก่อนครับ");

  let rawShop = ""; 
  if (currentIncomeData && (currentIncomeData.storeId || currentIncomeData.shop)) {
    rawShop = (currentIncomeData.storeId || currentIncomeData.shop).trim();
  }
  
  const dateVal = (currentIncomeData && currentIncomeData.dateRaw) 
                  ? currentIncomeData.dateRaw 
                  : document.getElementById('incomeFilterDate').value;
  if (!dateVal) return alert("กรุณาระบุวันที่ก่อนอัปโหลด");
  
  const [y, m, d] = dateVal.split("-");
  const formattedShop = standardizeShopNameFrontend(rawShop);
  const formattedFolder = `${formattedShop}_${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

  btn.disabled = true;
  statusDiv.classList.remove('d-none');
  progressBar.style.width = "10%";
  progressBar.classList.remove('bg-success', 'bg-danger');
  progressBar.classList.add('progress-bar-animated', 'bg-primary');
  
  let successCount = 0;
  const totalFiles = files.length;
  const uploadedFiles = []; 

  try {
    progressBar.style.width = "20%";
    statusText.innerText = `📁 กำลังเตรียมการเชื่อมต่อคลังเก็บไฟล์ Firebase Storage...`;
    
    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      statusText.innerText = `⏳ [${i + 1}/${totalFiles}] กำลังอัปโหลดไฟล์: ${file.name}`;
      
      const storagePath = `cash_out_library/${formattedShop}/${y}/${m.padStart(2, '0')}/${d.padStart(2, '0')}/${Date.now()}_${file.name}`;
      const storageRef = ref(storage, storagePath);
      const uploadTask = uploadBytesResumable(storageRef, file);
      
      await new Promise((resolve, reject) => {
        uploadTask.on(
          'state_changed', 
          (snapshot) => {
            const fileProgress = (snapshot.bytesTransferred / snapshot.totalBytes) * (100 / totalFiles);
            const totalProgress = Math.floor((successCount * (100 / totalFiles)) + fileProgress);
            progressBar.style.width = `${Math.max(20, totalProgress)}%`;
          }, 
          (error) => reject(error), 
          async () => {
            const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
            uploadedFiles.push({ name: file.name, url: downloadUrl });
            resolve();
          }
        );
      });

      successCount++;
      if (i < totalFiles - 1) {
        statusText.innerText = `🔄 ไฟล์ที่ ${i + 1} สำเร็จแล้ว... กำลังเตรียมไฟล์ถัดไป`;
      }
    }

    progressBar.style.width = "95%";
    statusText.innerText = `📝 กำลังนำรายชื่อไฟล์ขึ้นคิวตรวจ OCR ในระบบ...`;

    // บันทึกรายการไฟล์ลงคิว OCR บน Firestore (collection 'ocr_queue')
    const queueCol = collection(db, "ocr_queue");
    for (const fileObj of uploadedFiles) {
      await addDoc(queueCol, {
        timestamp: serverTimestamp(),
        source: "Firebase_Web",
        file_name: fileObj.name,
        status: "SAVED",
        url: fileObj.url,
        folder_name: formattedFolder,
        shop: formattedShop,
        date: dateVal,
        uploaded_by: window.currentUser?.name || "Unknown"
      });
    }

    await insertAuditLog(
      "UPLOAD_CASHOUT_FILES",
      `อัปโหลดบิล Cash Out ร้าน: ${formattedShop} วันที่: ${dateVal} จำนวน ${successCount} ไฟล์`,
      window.currentUser
    );

    progressBar.style.width = "100%";
    progressBar.classList.replace('bg-primary', 'bg-success');
    progressBar.classList.remove('progress-bar-animated');
    statusText.innerHTML = `<span class="text-success fw-bold">สำเร็จ! อัปโหลดเข้า Firebase และขึ้นคิวตรวจ OCR ครบทั้ง ${successCount} ไฟล์เรียบร้อยแล้ว</span>`;
    fileInput.value = "";
    btn.disabled = false;

  } catch (err) {
    console.error("❌ startBulkUpload Error:", err);
    alert("เกิดข้อผิดพลาดในการส่งข้อมูล: " + err.message);
    progressBar.classList.remove('progress-bar-animated');
    progressBar.classList.replace('bg-primary', 'bg-danger');
    statusText.innerHTML = `<span class="text-danger fw-bold">ล้มเหลว: ${escapeHtml(err.message || String(err))}</span>`;
    btn.disabled = false;
  }
}

// ============================================================================
// 💾 6. บันทึกข้อมูลรายรับรายวันลง Firestore (updateIncomeRecord)
// ============================================================================
async function saveIncomeData() {
  if (isSavingIncome) return;
  if (!currentIncomeData) return showToast("ไม่พบข้อมูลที่จะบันทึก", "danger");

  const getNumVal = (id) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || 0 : 0;
  };

  const getAdjValue = (signId, valId) => {
    const sign = document.getElementById(signId).value === 'minus' ? -1 : 1;
    const val = parseFloat(document.getElementById(valId).value) || 0;
    return sign * val;
  };

  const displayEl = document.getElementById('displayDiff');
  const netCash = displayEl ? parseFloat(displayEl.innerText.replace(/,/g, '')) : 0;

  let tipMethod = "-";
  const tipValue = getNumVal('inputTip');
  if (tipValue > 0) {
    const selected = document.querySelector('input[name="tipPaymentMethod"]:checked');
    tipMethod = selected ? selected.value : "-";
  }

  const dateId = currentIncomeData.dateRaw.toString().trim().replace(/\//g, "-");
  const storeId = standardizeShopNameFrontend(currentIncomeData.storeId || currentIncomeData.shop);

  if (!storeId || !dateId) {
    return showToast("ไม่พบรหัสร้านค้าหรือวันที่เอกสาร", "danger");
  }

  const updatePayload = {
    cash_out:     getNumVal('inputCashout'),
    tip:          tipValue,
    tip_type:     tipMethod,
    other_exp:    getNumVal('inputOther'),
    net_cash:     netCash,
    adj_visa:     getAdjValue('adjSignVisa', 'adjValVisa'),
    adj_master:   getAdjValue('adjSignMaster', 'adjValMaster'),
    adj_transfer: getAdjValue('adjSignTransfer', 'adjValTransfer'),
    adj_cash:     getAdjValue('adjSignCash', 'adjValCash'),
    status:       "done",
    updated_at:   new Date().toISOString()
  };

  const btnSave = document.getElementById("btnSaveIncomeData");
  const originalBtnHtml = btnSave.innerHTML;
  isSavingIncome = true;
  btnSave.disabled = true;
  btnSave.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึกข้อมูล...`;

  try {
    const recordRef = doc(db, "income", storeId, "daily_records", dateId);
    await setDoc(recordRef, updatePayload, { merge: true });

    await insertAuditLog(
      "UPDATE_INCOME",
      `แก้ไขสรุปรายวัน: ${storeId}_${dateId} (ร้าน: ${currentIncomeData.shop})`,
      window.currentUser
    );

    const index = allIncomes.findIndex(item => item.dateRaw === dateId && item.storeId === storeId);
    if (index !== -1) {
      allIncomes[index] = { ...allIncomes[index], ...updatePayload };
      filterIncomeTable();
    }

    document.getElementById('incomeEditSection').classList.add('d-none');
    document.getElementById('saveSuccessSection').classList.remove('d-none');
    showToast("บันทึกข้อมูลสำเร็จ", "success");

  } catch (err) {
    console.error("❌ saveIncomeData Error:", err);
    showToast("เกิดข้อผิดพลาด: " + err.message, "danger");
  } finally {
    isSavingIncome = false;
    btnSave.disabled = false;
    btnSave.innerHTML = originalBtnHtml;
  }
}

function prepareNewRecord() {
  document.getElementById('saveSuccessSection').classList.add('d-none');
  document.getElementById('incomeEditSection').classList.add('d-none');
  
  const dateInput = document.getElementById('incomeFilterDate');
  const shopInput = document.getElementById('incomeFilterShop');
  if (dateInput) dateInput.value = ""; 
  if (shopInput) shopInput.value = ""; 
  
  closeIncomeEdit(); 
  loadAllIncomes(); 
  document.getElementById('incomeForm').scrollIntoView({ behavior: 'smooth' });
}

// ============================================================================
// 🛠️ Helper Utilities
// ============================================================================
function standardizeShopNameFrontend(rawShop) {
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
    'ส่วนกลาง':             'ส่วนกลาง',
    'kitchen':             'ครัวกลาง',
    'mainkitchen':         'ครัวกลาง',
    'ครัวกลาง':             'ครัวกลาง'
  };
  return shopMap[lookupKey] || rawShop.trim().replace(/\s+/g, '_'); 
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
  return displayMap[shopClean] || shopClean.replace(/_/g, ' ');
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
window.loadAllIncomes = loadAllIncomes;
window.filterIncomeTable = filterIncomeTable;
window.handleSelectIncome = handleSelectIncome;
window.closeIncomeEdit = closeIncomeEdit;
window.calculateDiff = calculateDiff;
window.toggleTipType = toggleTipType;
window.startBulkUpload = startBulkUpload;
window.saveIncomeData = saveIncomeData;
window.prepareNewRecord = prepareNewRecord;