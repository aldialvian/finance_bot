const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Telegraf } = require('telegraf');

// Inisialisasi Firebase Admin SDK (untuk akses Firestore)
admin.initializeApp();
const db = admin.firestore();

// Ambil token dari environment variables
const botToken = functions.config().telegram.token;
if (!botToken) {
    throw new Error('Telegram token not set in environment config.');
}
const bot = new Telegraf(botToken);

// --- HELPER FUNCTION ---
// Fungsi untuk menghasilkan ID Transaksi yang mudah diingat (misalnya 6 digit)
const generateTransactionId = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// Fungsi untuk mendapatkan reference koleksi utama pengguna
const getCategoriesRef = (chatId) => db.collection('users').doc(chatId.toString()).collection('categories');

// Fungsi untuk mendapatkan reference koleksi transaksi
const getTransactionsRef = (chatId) => db.collection('users').doc(chatId.toString()).collection('transactions');

// --- 1. MEMBUAT/UPDATE KATEGORI (/tipe) ---
// Note: /tipe tetap dipertahankan untuk mengatur budget awal
bot.command('tipe', async (ctx) => {
    // Expected format: /tipe <NAMA KATEGORI> <JUMLAH BULANAN>
    const args = ctx.message.text.split(' ').slice(1);
    const categoryName = args[0] ? args[0].toUpperCase() : null;
    const budgetAmount = parseInt(args[1]);
    const chatId = ctx.chat.id;

    if (!categoryName || isNaN(budgetAmount) || budgetAmount <= 0) {
        return ctx.reply('Format salah. Gunakan: /tipe NAMA_KATEGORI JUMLAH_BUDGET (contoh: /tipe MAKAN 1000000)');
    }

    const categoryRef = getCategoriesRef(chatId).doc(categoryName);

    await categoryRef.set({
        monthly_budget: budgetAmount,
        last_updated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    ctx.reply(`✅ Budget Kategori **${categoryName}** berhasil diatur: Rp${budgetAmount.toLocaleString('id-ID')}.`, { parse_mode: 'Markdown' });
});

// --- 2. LOGIKA MENCATAT PEMASUKAN (/masuk) ---
bot.command('masuk', async (ctx) => {
    // Expected format: /masuk <JUMLAH> <KATEGORI> [KETERANGAN]
    const args = ctx.message.text.split(' ').slice(1);
    const amount = parseInt(args[0]);
    const categoryName = args[1] ? args[1].toUpperCase() : 'PEMASUKAN_LAIN';
    const description = args.slice(2).join(' ') || '';
    const chatId = ctx.chat.id;

    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Format salah. Gunakan: /masuk JUMLAH KATEGORI [KETERANGAN] (contoh: /masuk 500000 BONUS)');
    }

    const transactionId = generateTransactionId();
    const transactionData = {
        id: transactionId,
        type: 'INCOME',
        category: categoryName,
        amount: amount,
        description: description,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Simpan ke koleksi transaksi utama
    await getTransactionsRef(chatId).doc(transactionId).set(transactionData);

    ctx.reply(`💰 Pemasukan **${categoryName}** Rp${amount.toLocaleString('id-ID')} dicatat (ID: ${transactionId}).`, { parse_mode: 'Markdown' });
});


// --- 3. LOGIKA MENCATAT PENGELUARAN (/keluar) ---
bot.command('keluar', async (ctx) => {
    // Expected format: /keluar <JUMLAH> <KATEGORI> [KETERANGAN]
    const args = ctx.message.text.split(' ').slice(1);
    const amount = parseInt(args[0]);
    const categoryName = args[1] ? args[1].toUpperCase() : 'NON_BUDGET';
    const description = args.slice(2).join(' ') || '';
    const chatId = ctx.chat.id;

    if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Format salah. Gunakan: /keluar JUMLAH KATEGORI [KETERANGAN] (contoh: /keluar 50000 MAKAN)');
    }

    const transactionId = generateTransactionId();
    const transactionData = {
        id: transactionId,
        type: 'EXPENSE',
        category: categoryName,
        amount: amount * -1, // Simpan sebagai angka negatif
        description: description,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Simpan ke koleksi transaksi utama
    await getTransactionsRef(chatId).doc(transactionId).set(transactionData);

    ctx.reply(`💸 Pengeluaran **${categoryName}** Rp${amount.toLocaleString('id-ID')} dicatat (ID: ${transactionId}).`, { parse_mode: 'Markdown' });
});

// --- 4. LOGIKA MENAMPILKAN TRANSAKSI TERBARU (/history) ---
bot.command('history', async (ctx) => {
    const chatId = ctx.chat.id;
    const snapshot = await getTransactionsRef(chatId)
        .orderBy('timestamp', 'desc')
        .limit(10) // Tampilkan 10 transaksi terbaru
        .get();

    if (snapshot.empty) {
        return ctx.reply('Belum ada riwayat transaksi yang tercatat.');
    }

    let replyMessage = '*10 Transaksi Terbaru:*\n\n';
    
    snapshot.forEach(doc => {
        const data = doc.data();
        const sign = data.type === 'INCOME' ? '🟢' : '🔴';
        const amountDisplay = Math.abs(data.amount).toLocaleString('id-ID');
        const date = data.timestamp.toDate().toLocaleDateString('id-ID');

        replyMessage += `${sign} **${amountDisplay}** (${data.category}) \n`;
        replyMessage += `  - ID: ${data.id} | ${date}\n`;
        if (data.description) {
             replyMessage += `  - Ket: ${data.description}\n`;
        }
    });

    replyMessage += '\n*Gunakan /revisi <ID> jika ada kesalahan.*';

    ctx.reply(replyMessage, { parse_mode: 'Markdown' });
});

// --- 5. LOGIKA REVISI TRANSAKSI (/revisi) ---
bot.command('revisi', async (ctx) => {
    // Expected format: /revisi <TRANSACTION_ID>
    const args = ctx.message.text.split(' ').slice(1);
    const transactionId = args[0] ? args[0].toUpperCase() : null;
    const chatId = ctx.chat.id;

    if (!transactionId) {
        return ctx.reply('Format salah. Gunakan: /revisi ID_TRANSAKSI (Lihat ID transaksi dengan /history)');
    }

    const transactionRef = getTransactionsRef(chatId).doc(transactionId);
    const doc = await transactionRef.get();

    if (!doc.exists) {
        return ctx.reply(`❌ Transaksi dengan ID **${transactionId}** tidak ditemukan.`);
    }

    // Hapus transaksi lama
    await transactionRef.delete();

    ctx.reply(`✅ Transaksi (ID: ${transactionId}) berhasil *DIHAPUS*.\n\nSekarang Anda dapat memasukkan data yang benar menggunakan /masuk atau /keluar.`, { parse_mode: 'Markdown' });
});


// --- 6. LOGIKA MENAMPILKAN SALDO / LIST KATEGORI (/list) ---
bot.command('list', async (ctx) => {
    const chatId = ctx.chat.id;

    // 1. Ambil semua kategori budget
    const categoriesSnapshot = await getCategoriesRef(chatId).get();
    
    // 2. Hitung total pemasukan dan pengeluaran dari koleksi transaksi
    const transactionsSnapshot = await getTransactionsRef(chatId).get();
    
    let totalSpentPerCategory = {};
    let totalIncome = 0;
    let totalExpense = 0;

    transactionsSnapshot.forEach(doc => {
        const data = doc.data();
        const category = data.category;
        const amount = data.amount;

        if (data.type === 'INCOME') {
            totalIncome += amount;
        } else if (data.type === 'EXPENSE') {
            totalExpense += amount; // Amount sudah negatif
        }
        
        // Hitung pengeluaran per kategori
        if (data.type === 'EXPENSE') {
            totalSpentPerCategory[category] = (totalSpentPerCategory[category] || 0) + Math.abs(amount);
        }
    });

    let replyMessage = '*Laporan Keuangan Saat Ini:*\n\n';

    // Laporan Kategori Budget
    if (!categoriesSnapshot.empty) {
        replyMessage += '*--- Budget Bulanan ---\n';
        categoriesSnapshot.forEach(doc => {
            const budget = doc.data().monthly_budget;
            const spent = totalSpentPerCategory[doc.id] || 0;
            const remaining = budget - spent;

            const status = remaining >= 0 ? '🟢 Sisa' : '🔴 Overbudget';
            
            replyMessage += `*${doc.id}*\n`;
            replyMessage += `  - Budget: Rp${budget.toLocaleString('id-ID')}\n`;
            replyMessage += `  - Terpakai: Rp${spent.toLocaleString('id-ID')}\n`;
            replyMessage += `  - ${status}: Rp${Math.abs(remaining).toLocaleString('id-ID')}\n\n`;
        });
    }

    // Laporan Kas & Total
    const totalKas = totalIncome + totalExpense;
    replyMessage += '*--- Total Kas ---\n';
    replyMessage += `💰 Pemasukan (Total): Rp${totalIncome.toLocaleString('id-ID')}\n`;
    replyMessage += `💸 Pengeluaran (Total): Rp${Math.abs(totalExpense).toLocaleString('id-ID')}\n`;
    replyMessage += `**Saldo Kas Bersih: Rp${totalKas.toLocaleString('id-ID')}**\n`;


    ctx.reply(replyMessage, { parse_mode: 'Markdown' });
});


// --- 7. BANTUAN (/help) ---
bot.command('help', (ctx) => {
    const helpMessage = `
*Panduan Penggunaan Bot Keuangan:*

*1. Pengaturan Budget:*
/tipe NAMA_KATEGORI JUMLAH_BULANAN
    Contoh: \`/tipe MAKAN 1500000\`

*2. Mencatat Transaksi:*
/masuk JUMLAH KATEGORI [KETERANGAN]
    Contoh: \`/masuk 500000 BONUS istri\`
/keluar JUMLAH KATEGORI [KETERANGAN]
    Contoh: \`/keluar 50000 MAKAN siang\`

*3. Laporan & Bantuan:*
/list
    Menampilkan semua budget dan saldo kas saat ini.
/history
    Menampilkan 10 transaksi terakhir (bersama ID).
/revisi ID_TRANSAKSI
    Menghapus transaksi berdasarkan ID (Gunakan /history untuk melihat ID).
/help
    Menampilkan panduan ini.
`;
    ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});


// Handler untuk pesan yang tidak dikenal
bot.on('text', (ctx) => {
    if (ctx.message.text.startsWith('/')) {
        ctx.reply('Perintah tidak dikenal. Ketik /help untuk melihat daftar perintah.');
    }
});


// Export Cloud Function yang akan menjadi Webhook
exports.telegramBot = functions.https.onRequest(async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (error) {
        functions.logger.error("Error handling update:", error);
        res.status(200).send("OK");
    }
});