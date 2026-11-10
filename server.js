require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const users = {};
const tokens = {};
const rooms = {};
const txns = [];

const SEAT_COUNT = 8;
const PLATFORM_CUT = 0.4;

const GIFTS = {
  rose:   { name: 'Rose',   price: 10 },
  heart:  { name: 'Heart',  price: 50 },
  car:    { name: 'Car',    price: 500 },
  castle: { name: 'Castle', price: 2000 },
};

const id = () => crypto.randomBytes(6).toString('hex');

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const uid = tokens[t];
  if (!uid) return res.status(401).json({ error: 'Login required' });
  req.user = users[uid];
  next();
}

function publicRoom(r) {
  return {
    id: r.id,
    title: r.title,
    hostId: r.hostId,
    seats: r.seats.map((uid) =>
      uid ? { userId: uid, name: users[uid].name } : null
    ),
  };
}

app.post('/auth/login', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const userId = id();
  users[userId] = { id: userId, name, coins: 100, diamonds: 0 };
  const token = id() + id();
  tokens[token] = userId;
  txns.push({ userId, type: 'welcome_bonus', coins: 100, at: Date.now() });
  res.json({ token, user: users[userId] });
});

app.get('/me', auth, (req, res) => res.json(req.user));

app.get('/rooms', auth, (_req, res) => {
  res.json(Object.values(rooms).map(publicRoom));
});

app.post('/rooms', auth, (req, res) => {
  const title = (req.body.title || '').trim() || `${req.user.name}'s room`;
  const room = {
    id: id(),
    title,
    hostId: req.user.id,
    seats: Array(SEAT_COUNT).fill(null),
  };
  room.seats[0] = req.user.id;
  rooms[room.id] = room;
  res.json(publicRoom(room));
});

app.get('/rooms/:id', auth, (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(publicRoom(room));
});

app.post('/rooms/:id/seat', auth, (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const i = Number(req.body.seat);
  if (!Number.isInteger(i) || i < 0 || i >= SEAT_COUNT)
    return res.status(400).json({ error: 'Bad seat' });
  if (room.seats[i]) return res.status(409).json({ error: 'Seat taken' });
  room.seats = room.seats.map((u) => (u === req.user.id ? null : u));
  room.seats[i] = req.user.id;
  res.json(publicRoom(room));
});

app.post('/rooms/:id/leave-seat', auth, (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.seats = room.seats.map((u) => (u === req.user.id ? null : u));
  res.json(publicRoom(room));
});

app.post('/rooms/:id/kick', auth, (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id)
    return res.status(403).json({ error: 'Only host' });
  const target = req.body.userId;
  if (target === room.hostId)
    return res.status(400).json({ error: 'Cannot kick host' });
  room.seats = room.seats.map((u) => (u === target ? null : u));
  res.json(publicRoom(room));
});

app.get('/rooms/:id/token', auth, async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const onSeat = room.seats.includes(req.user.id);
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: req.user.id, name: req.user.name, ttl: '2h' }
  );
  at.addGrant({
    room: room.id,
    roomJoin: true,
    canSubscribe: true,
    canPublish: onSeat,
    canPublishData: true,
  });
  res.json({ token: await at.toJwt(), url: process.env.LIVEKIT_URL });
});

app.get('/gifts', (_req, res) => res.json(GIFTS));

app.post('/gifts/send', auth, (req, res) => {
  const { toUserId, giftId } = req.body;
  const gift = GIFTS[giftId];
  const to = users[toUserId];
  if (!gift || !to) return res.status(400).json({ error: 'Bad gift or user' });
  if (to.id === req.user.id)
    return res.status(400).json({ error: 'Cannot gift yourself' });
  if (req.user.coins < gift.price)
    return res.status(402).json({ error: 'Not enough coins' });
  const earned = Math.floor(gift.price * (1 - PLATFORM_CUT));
  req.user.coins -= gift.price;
  to.diamonds += earned;
  txns.push({ userId: req.user.id, type: 'gift_sent', coins: -gift.price, to: to.id, at: Date.now() });
  txns.push({ userId: to.id, type: 'gift_received', diamonds: earned, from: req.user.id, at: Date.now() });
  res.json({ coins: req.user.coins, gift: gift.name, receiverDiamonds: earned });
});

app.post('/coins/demo-recharge', auth, (req, res) => {
  req.user.coins += 100;
  txns.push({ userId: req.user.id, type: 'demo_recharge', coins: 100, at: Date.now() });
  res.json({ coins: req.user.coins });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (_req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server on :${port}`));
