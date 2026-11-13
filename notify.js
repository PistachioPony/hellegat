// Hellegat's Notify me button: subscribes this browser to slack notifications.
// Still being built, so the button is hidden from browser visitors unless the address ends in ?notify.
// It always shows in Hellegat opened from a Home Screen icon: that always starts at plain "/",
// and on iPhone it's the only place notifications can work.

const button = document.getElementById("notify-btn");
const message = document.getElementById("notify-msg");
const offButton = document.getElementById("notify-off");
// A second Notify me at the bottom of the slack reveal, for visitors who won't wait for the image to sink.
// It shows only to devices that aren't subscribed, and only replies to its own tap.
const revealButton = document.getElementById("reveal-notify-btn");
const revealMessage = document.getElementById("reveal-notify-msg");

// Placeholder wording; Maria writes the final text.
const TEXT = {
  addToHomeScreen: "On iPhone, notifications come only from Hellegat on your Home Screen. Tap the Share button, then Add to Home Screen. Open Hellegat from its new icon and tap Notify me there.",
  blocked: "Notifications are blocked for Hellegat in this browser. You can allow them in the browser's settings for this site.",
  unsupported: "This browser can't receive notifications. The Remind me buttons can add a slack to your calendar instead.",
  dismissed: "Notifications weren't turned on. Tap Notify me to try again.",
  working: "Subscribing…",
  subscribed: "You'll be notified before slack.",
  failed: "Something went wrong. Please try again.",
  turningOff: "Turning off…",
  off: "Notifications are off.",
};

// Firebase's public settings for the Hellegat project. These identify the project; they are not secrets.
// What browsers may do with it is limited by the Firestore rules.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBeTBHjfOgUUlzNq_yzg6F4YBTFHeL0EY0",
  authDomain: "hellegat-2d815.firebaseapp.com",
  projectId: "hellegat-2d815",
  storageBucket: "hellegat-2d815.firebasestorage.app",
  messagingSenderId: "995489325092",
  appId: "1:995489325092:web:f98df6f7ef463d38ceb8b1",
};
const VAPID_KEY = "BNhQVwuIJ_AAoQJtIExm6gAWSfBASOhCmF6hL-z46VSom6NZThL-XoYmramU2iBFVHvjsRQKrSfNmB1hZgFweJo";
const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/12.14.0/";

// Shows a message under the countdown's button, or under whichever button was tapped.
function show(text, where = message) {
  where.textContent = text;
  where.hidden = false;
}

// iPads report themselves as Macs, so a "Mac" with a touchscreen counts as an iPad.
function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

// True when Hellegat was opened from its Home Screen icon rather than in a browser tab.
function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

// The two views: subscribed (a note and a Turn off link) or not (the Notify me button).
// The reveal only ever has its button (when not subscribed) or nothing.
function showSubscribed() {
  button.hidden = true;
  show(TEXT.subscribed);
  offButton.hidden = false;
  revealButton.hidden = true;
}

function showNotSubscribed(text) {
  offButton.hidden = true;
  button.hidden = false;
  if (text) show(text);
  revealButton.hidden = false;
  revealMessage.hidden = true;
}

// Is this device already subscribed? The browser knows, so no Firebase or Firestore is needed to ask.
async function isSubscribed() {
  const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!canPush || Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(registration && await registration.pushManager.getSubscription());
}

if (new URLSearchParams(location.search).has("notify") || isStandalone()) {
  isSubscribed()
    .then(subscribed => subscribed ? showSubscribed() : showNotSubscribed())
    .catch(() => showNotSubscribed());
}

// Which situation is this browser in?
function situation() {
  const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!canPush && isIOS() && !isStandalone()) return "addToHomeScreen";
  if (!canPush) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "ready";
}

// Firebase is downloaded only when someone subscribes, and only once.
let firebase;
function loadFirebase() {
  firebase ??= Promise.all([
    import(FIREBASE_CDN + "firebase-app.js"),
    import(FIREBASE_CDN + "firebase-firestore.js"),
    import(FIREBASE_CDN + "firebase-messaging.js"),
  ]).then(([appLib, firestoreLib, messagingLib]) => {
    const app = appLib.initializeApp(FIREBASE_CONFIG);
    return {
      db: firestoreLib.getFirestore(app),
      messaging: messagingLib.getMessaging(app),
      ...firestoreLib,
      getToken: messagingLib.getToken,
      deleteToken: messagingLib.deleteToken,
    };
  });
  return firebase;
}

// Returns how it ended (a TEXT name), so the tapped button's own message can say so.
async function subscribe(where) {
  // Ask first, while the tap is still fresh: browsers ignore permission requests that a person didn't trigger.
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "dismissed";

  show(TEXT.working, where);
  const { db, messaging, getToken, doc, setDoc, serverTimestamp } = await loadFirebase();

  // Use Hellegat's own service worker (sw.js), not Firebase's default firebase-messaging-sw.js.
  const serviceWorkerRegistration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration });

  // Exactly the shape the Firestore rules allow: the token as the document's name, plus the server's clock.
  await setDoc(doc(db, "subscriptions", token), { token, created: serverTimestamp() });
  showSubscribed();
  return "subscribed";
}

// Turn off: remove this device's subscription from Firestore, then have the browser drop it too.
// Asking Firebase for the token again returns the same one this browser already has.
async function unsubscribe() {
  show(TEXT.turningOff);
  const { db, messaging, getToken, deleteToken, doc, deleteDoc } = await loadFirebase();
  const serviceWorkerRegistration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration });
  await deleteDoc(doc(db, "subscriptions", token));
  await deleteToken(messaging);
  showNotSubscribed(TEXT.off);
}

offButton.addEventListener("click", async () => {
  offButton.disabled = true;
  try {
    await unsubscribe();
  } catch (err) {
    console.error("Turn off failed:", err);
    show(TEXT.failed);
  } finally {
    offButton.disabled = false;
  }
});

// Both Notify me buttons work the same way; each reply appears under the button that was tapped.
async function onNotifyTap(tapped, where) {
  let outcome = situation();
  if (outcome === "ready") {
    tapped.disabled = true;
    try {
      outcome = await subscribe(where);
    } catch (err) {
      console.error("Notify me failed:", err);
      outcome = "failed";
    } finally {
      tapped.disabled = false;
    }
  }
  show(TEXT[outcome], where);
  // In the reveal the button steps aside after answering, unless trying again could help.
  if (tapped === revealButton && outcome !== "failed" && outcome !== "dismissed") revealButton.hidden = true;
}

button.addEventListener("click", () => onNotifyTap(button, message));
revealButton.addEventListener("click", () => onNotifyTap(revealButton, revealMessage));
