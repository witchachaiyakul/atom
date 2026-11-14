// public/js/firestore.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Firebase Web Configuration (Atom Group Phi Phi)
const firebaseConfig = {
  apiKey: "AIzaSyCWUV84YNPO71wZBjFjosdlvV2J3h_hcVE",
  authDomain: "atom-group-phi-phi.firebaseapp.com",
  databaseURL: "https://atom-group-phi-phi-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "atom-group-phi-phi",
  storageBucket: "atom-group-phi-phi.firebasestorage.app",
  messagingSenderId: "332930883247",
  appId: "1:332930883247:web:6da9a78203f95cf2acbe5a",
  measurementId: "G-KQHDPVZ397"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ============================================================================
// 🛡️ USER PERMISSIONS (COLLECTION 'users') & AUDIT LOGS
// ============================================================================

/**
 * ดึงข้อมูลและสิทธิ์ผู้ใช้งานจาก LINE User ID ใน collection 'users'
 * โครงสร้าง: /users/{lineUserId} -> { name, role, status: "active", hr: "active", allowedOptions: "..." }
 */
export async function getUserByLineId(lineUserId) {
  try {
    const userRef = doc(db, "users", lineUserId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      console.warn(`⚠️ ไม่พบข้อมูลพนักงาน ID: ${lineUserId} ใน collection 'users'`);
      return null;
    }

    const data = userSnap.data();
    const allowedOptionsRaw = data.allowedOptions || "";
    let allowedOptions = [];

    if (Array.isArray(allowedOptionsRaw)) {
      allowedOptions = allowedOptionsRaw;
    } else if (typeof allowedOptionsRaw === "string" && allowedOptionsRaw.trim() !== "") {
      allowedOptions = allowedOptionsRaw.split(",").map(item => item.trim());
    }

    return {
      id: userSnap.id,
      name: data.name || "",
      role: data.role || "staff",
      status: data.status || "", // สิทธิ์ระบบหลังบ้าน (Back-Office)
      hr: data.hr || "",         // สิทธิ์ระบบบุคคล (HR)
      allowedOptions: allowedOptions
    };
  } catch (error) {
    console.error("❌ ค้นหาสิทธิ์จาก collection 'users' ล้มเหลว:", error);
    throw error;
  }
}

/**
 * บันทึก Audit Log ลง Firestore collection 'audit_logs'
 */
export async function insertAuditLog(actionType, detailsTxt, lineUserObj) {
  try {
    const logDocId = `LOG_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const logRef = doc(db, "audit_logs", logDocId);

    await setDoc(logRef, {
      timestamp: serverTimestamp(),
      action: actionType,
      details: detailsTxt,
      user_id: lineUserObj ? lineUserObj.id : "System",
      user_name: lineUserObj ? lineUserObj.name : "Unknown",
      user_picture: lineUserObj?.picture || ""
    });
    console.log(`✅ Audit Log Saved: [${actionType}] ${detailsTxt}`);
  } catch (error) {
    console.error("❌ บันทึก Audit Log ล้มเหลว:", error);
  }
}