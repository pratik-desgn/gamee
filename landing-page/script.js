// ===== CONFIGURATION =====
const GAMES = [
  { name: 'Wing Rush',    difficulty: 'easy',    color: '#22c55e', weight: 8 },
  { name: 'Dino Sprint',  difficulty: 'easy',    color: '#22c55e', weight: 7 },
  { name: 'Perfect Stack',difficulty: 'easy',    color: '#22c55e', weight: 7 },
  { name: 'Block Merge',  difficulty: 'medium',  color: '#eab308', weight: 5 },
  { name: 'Simon Pro',    difficulty: 'medium',  color: '#eab308', weight: 5 },
  { name: 'Aim Master',   difficulty: 'medium',  color: '#eab308', weight: 4 },
  { name: 'Helix Drop',   difficulty: 'hard',    color: '#ef4444', weight: 3 },
  { name: 'Minefield',    difficulty: 'hard',    color: '#ef4444', weight: 2 },
  { name: 'Legend Run',   difficulty: 'legend',  color: '#a855f7', weight: 1 },
];

const DIFF_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', legend: 'Legendary' };

// ===== Wheel Setup =====
const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const spinBtn = document.getElementById('spinBtn');
const resultDiv = document.getElementById('wheel-result');

let currentRotation = 0;
let isSpinning = false;
let spinVelocity = 0;

// Build weighted segments
function buildSegments() {
  const segments = [];
  GAMES.forEach(g => {
    for (let i = 0; i < g.weight; i++) segments.push(g);
  });
  return segments;
}
let segments = buildSegments();
const segmentAngle = (2 * Math.PI) / segments.length;

function drawWheel(rotation) {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = w / 2 - 4;
  ctx.clearRect(0, 0, w, h);

  segments.forEach((game, i) => {
    const startAngle = rotation + i * segmentAngle;
    const endAngle = startAngle + segmentAngle;
    const midAngle = startAngle + segmentAngle / 2;

    // Fill
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = game.color + '33'; // 20% opacity
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Text
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(midAngle);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e2e2e8';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(game.name, r - 14, 4);
    ctx.restore();
  });

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, 2 * Math.PI);
  ctx.fillStyle = '#0a0a0f';
  ctx.fill();
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Outer ring glow
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(168,85,247,0.15)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function getSelectedGame(rotation) {
  // Pointer is at top (3π/2 in canvas coords)
  const pointerAngle = (3 * Math.PI) / 2;
  let normalized = ((pointerAngle - rotation) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const index = Math.floor(normalized / segmentAngle) % segments.length;
  return segments[index];
}

// ===== Spin Logic =====
function spinWheel() {
  if (isSpinning) return;
  isSpinning = true;
  spinBtn.disabled = true;

  // Target: spin multiple full rotations + random stop
  const extraTurns = 5 + Math.floor(Math.random() * 3);
  // Pick a random target segment
  const targetIndex = Math.floor(Math.random() * segments.length);
  const targetAngle = targetIndex * segmentAngle + segmentAngle / 2;
  // The pointer sits at 3π/2, so we need the segment's center to align there
  const targetRotation = currentRotation + extraTurns * 2 * Math.PI + (3 * Math.PI / 2 - targetAngle + currentRotation % (2 * Math.PI));

  const startRotation = currentRotation;
  const totalDelta = targetRotation - startRotation;
  const duration = 3000 + Math.random() * 1000;
  const startTime = performance.now();

  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    currentRotation = startRotation + totalDelta * eased;
    drawWheel(currentRotation);

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      isSpinning = false;
      spinBtn.disabled = false;
      showResult();
    }
  }
  requestAnimationFrame(animate);
}

function showResult() {
  const game = getSelectedGame(currentRotation);
  const diffClass = game.difficulty;
  resultDiv.innerHTML = `
    <div class="result-game">
      🎮 ${game.name}
      <span class="diff-badge ${diffClass}">${DIFF_NAMES[diffClass]}</span>
    </div>
  `;
}

spinBtn.addEventListener('click', spinWheel);

// Initial draw
drawWheel(0);

// ===== Jackpot Counter =====
const jackpotEl = document.getElementById('jackpot-value');
const jackpotUsd = document.getElementById('jackpot-usd');
let jackpot = 12.47;
const SOL_PRICE = 185; // approx USD

function animateJackpot() {
  // Simulate steady growth
  const increment = 0.01 + Math.random() * 0.03; // $0.01-$0.04 per tick
  jackpot += increment;
  jackpotEl.textContent = jackpot.toFixed(2);
  jackpotUsd.textContent = '$' + (jackpot * SOL_PRICE).toLocaleString(undefined, { maximumFractionDigits: 0 });

  // Random jump when someone "wins" (simulated)
  if (Math.random() < 0.005) {
    const winAmount = (0.5 + Math.random() * 5);
    jackpot = Math.max(8, jackpot - winAmount);
    addWinnerNotification(winAmount);
  }

  const nextDelay = 800 + Math.random() * 1200;
  setTimeout(animateJackpot, nextDelay);
}
animateJackpot();

// ===== Social Proof Counters =====
const playersOnlineEl = document.getElementById('players-online');
const todayPlaysEl = document.getElementById('today-plays');
const totalWinnersEl = document.getElementById('total-winners');

let playersOnline = 142;
let todayPlays = 3784;
let totalWinners = 89;

function updateSocialProof() {
  playersOnline += Math.floor(Math.random() * 3) - 1; // -1 to +2
  playersOnline = Math.max(80, Math.min(400, playersOnline));
  todayPlays += Math.floor(2 + Math.random() * 6);
  totalWinners += Math.random() < 0.1 ? 1 : 0;

  playersOnlineEl.textContent = playersOnline.toLocaleString();
  todayPlaysEl.textContent = todayPlays.toLocaleString();
  totalWinnersEl.textContent = totalWinners.toLocaleString();

  setTimeout(updateSocialProof, 3000 + Math.random() * 4000);
}
updateSocialProof();

// ===== Winner Notifications =====
const ticker = document.getElementById('ticker');
const winnerNames = [
  'flappy_sam', 'crypto_runner88', 'moon_monkey', 'sol_wizard42',
  'nft_jake', 'pixel_queen', 'blockchain_bob', 'defi_dan',
  'metaverse_mia', 'token_tom', 'dao_diana', 'validator_vic'
];

function addWinnerNotification(amount) {
  const name = winnerNames[Math.floor(Math.random() * winnerNames.length)];
  const solAmount = amount.toFixed(1);
  const item = document.createElement('span');
  item.className = 'ticker-item';
  item.textContent = `🟢 ${name} won ◎${solAmount} — just now`;
  ticker.appendChild(item);

  // Remove old items to keep ticker manageable
  while (ticker.children.length > 20) {
    ticker.removeChild(ticker.firstChild);
  }
}

// ===== Waitlist Counter =====
let waitlistCount = 847;
const waitlistCountEl = document.getElementById('waitlist-count');
waitlistCountEl.textContent = waitlistCount.toLocaleString();

function incrementWaitlist() {
  waitlistCount += Math.floor(1 + Math.random() * 2);
  waitlistCountEl.textContent = waitlistCount.toLocaleString();
}
setInterval(incrementWaitlist, 8000 + Math.random() * 12000);

// ===== Waitlist Form =====
const form = document.getElementById('waitlist-form');
const formNote = document.getElementById('form-note');

form.addEventListener('submit', function(e) {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  if (!email) return;

  waitlistCount++;
  waitlistCountEl.textContent = waitlistCount.toLocaleString();

  formNote.textContent = '🎉 You\'re on the list! We\'ll email you when we launch.';
  formNote.style.color = '#22c55e';
  form.reset();
});

// ===== Intersection Observer for fade-in =====
const observerOptions = { threshold: 0.1 };
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, observerOptions);

document.querySelectorAll('.step, .game-card').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  observer.observe(el);
});
