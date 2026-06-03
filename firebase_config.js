import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// TODO: Replace with your actual Firebase project settings
export const firebaseConfig = {
 apiKey: "AIzaSyArRl2JDdzTOANrhdN8QUjOaMbuuQoI1ig",
  authDomain: "rajasthan-jal-board.firebaseapp.com",
  projectId: "rajasthan-jal-board",
  storageBucket: "rajasthan-jal-board.firebasestorage.app",
  messagingSenderId: "680265798851",
  appId: "1:680265798851:web:d5d767b35ac75a7b0b7e76",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
