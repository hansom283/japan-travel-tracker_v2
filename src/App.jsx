import React, { useState, useEffect, useRef, useMemo } from 'react';

// --- 常數與類別設定 ---
const CATEGORIES = [
  { name: '餐飲', emoji: '🍜', color: '#c0392b' },
  { name: '交通', emoji: '🚇', color: '#2980b9' },
  { name: '住宿', emoji: '🏨', color: '#27ae60' },
  { name: '購物', emoji: '🛍️', color: '#8e44ad' },
  { name: '景點', emoji: '🗼', color: '#e67e22' },
  { name: '其他', emoji: '💴', color: '#7f8c8d' },
];

const getCategoryEmoji = (catName) => {
  const cat = CATEGORIES.find(c => c.name === catName);
  return cat ? cat.emoji : '💴';
};

const formatCurrency = (num) => {
  return new Intl.NumberFormat('en-US').format(Math.round(num));
};

const getTodayString = () => {
  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  return (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// --- 雲端同步網址 ---
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx8i1yb03bpXqpEp9HEpYcSQ6q9vNLFBq7LfuXkY_rfZCPcb1occUYts_2eEyplmwmV/exec'; 

// --- Gemini API 辨識邏輯 ---
const analyzeReceiptWithGemini = async (base64Image, mimeType) => {
  // 🌟 請將您的 API Key 字串貼在下方的引號內
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: "請分析這張日本收據。提取出店名(name，請務必將日文翻譯成繁體中文)、日期(date, 格式為 YYYY-MM-DD)、總金額(amountJpy, 僅數字)、最適當的類別(category, 必須是以下之一：餐飲, 交通, 購物, 住宿, 景點, 其他)、以及簡單的備註(note)。金額請確保是日圓(JPY)。若日期包含漢字請轉換為標準的 YYYY-MM-DD。" },
        { inlineData: { mimeType: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          date: { type: "STRING" },
          amountJpy: { type: "INTEGER" },
          category: { type: "STRING" },
          note: { type: "STRING" }
        },
        required: ["name", "date", "amountJpy", "category"]
      }
    }
  };

  const retries = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textResponse) throw new Error("無效的 API 回應");
      let parsedData = JSON.parse(textResponse);
      if (parsedData.date) {
        let d = parsedData.date.replace(/[年|月|\/|\.]/g, '-').replace(/[日]/g, '');
        let parts = d.split('-').filter(p => p !== '');
        if (parts[0] && parts[0].length === 2) parts[0] = '20' + parts[0];
        if (parts[1] && parts[1].length === 1) parts[1] = '0' + parts[1];
        if (parts[2] && parts[2].length === 1) parts[2] = '0' + parts[2];
        if (parts.length === 3) parsedData.date = parts.join('-');
      }
      return parsedData;
    } catch (error) {
      if (attempt === retries.length) throw new Error("AI 辨識失敗。");
      await delay(retries[attempt]);
    }
  }
};

export default function App() {
  const [tab, setTab] = useState('home');
  const [expenses, setExpenses] = useState([]);
  const [settings, setSettings] = useState({ exchangeRate: 0.22, dailyBudgetJpy: 10000, autoRate: true });
  const [isSyncing, setIsSyncing] = useState(false);
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [quickName, setQuickName] = useState('');
  const [quickAmount, setQuickAmount] = useState('');
  const [quickCat, setQuickCat] = useState('餐飲');
  const [quickDate, setQuickDate] = useState(getTodayString());
  const [quickNote, setQuickNote] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [currentExpense, setCurrentExpense] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (settings.autoRate) {
      fetch('https://open.er-api.com/v6/latest/JPY')
        .then(res => res.json())
        .then(data => {
          if (data?.rates?.TWD) {
            const latestRate = Number(data.rates.TWD.toFixed(4));
            setSettings(prev => ({ ...prev, exchangeRate: latestRate }));
          }
        })
        .catch(err => console.error("匯率抓取失敗:", err));
    }
  }, [settings.autoRate]);

  useEffect(() => {
    const savedExpenses = localStorage.getItem('jp_records_v4');
    if (savedExpenses) setExpenses(JSON.parse(savedExpenses));
    const savedSettings = localStorage.getItem('jp_settings_v4');
    if (savedSettings) setSettings(JSON.parse(savedSettings));

    const fetchCloudData = async () => {
      if (!SCRIPT_URL) return;
      setIsSyncing(true);
      try {
        const res = await fetch(SCRIPT_URL);
        const cloudData = await res.json();
        if (Array.isArray(cloudData)) {
          setExpenses(cloudData);
          localStorage.setItem('jp_records_v4', JSON.stringify(cloudData));
        }
      } catch (err) { console.error('Cloud sync failed:', err); }
      finally { setIsSyncing(false); }
    };
    fetchCloudData();
  }, []);

  useEffect(() => {
    localStorage.setItem('jp_records_v4', JSON.stringify(expenses));
    localStorage.setItem('jp_settings_v4', JSON.stringify(settings));
  }, [expenses, settings]);

  const totalJpy = expenses.reduce((sum, exp) => sum + exp.amountJpy, 0);
  const totalTwd = totalJpy * settings.exchangeRate;
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  const expensesByDate = useMemo(() => {
    return sortedExpenses.reduce((acc, exp) => {
      if (!acc[exp.date]) acc[exp.date] = [];
      acc[exp.date].push(exp);
      return acc;
    }, {});
  }, [sortedExpenses]);

  const syncToCloud = async (payload) => {
    if (!SCRIPT_URL) return;
    setIsSyncing(true);
    try { await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }); }
    catch (err) { console.error('Failed to sync', err); }
    finally { setIsSyncing(false); }
  };

  const handleQuickAdd = () => {
    if (!quickName || !quickAmount) return alert('請填寫名稱與金額');
    const newExp = { id: Date.now().toString(), name: quickName, amountJpy: Number(quickAmount), category: quickCat, date: quickDate || getTodayString(), note: quickNote };
    setExpenses(prev => [newExp, ...prev]);
    setQuickName(''); setQuickAmount(''); setQuickNote('');
    syncToCloud({ action: 'add', data: newExp });
  };

  const handleSaveExpense = () => {
    if (!currentExpense.name || !currentExpense.amountJpy || !currentExpense.date) return;
    const newExp = { ...currentExpense, amountJpy: Number(currentExpense.amountJpy) };
    setExpenses(prev => {
      const exists = prev.find(p => p.id === newExp.id);
      if (exists) return prev.map(p => p.id === newExp.id ? newExp : p);
      return [newExp, ...prev];
    });
    setIsEditing(false); setCurrentExpense(null);
    syncToCloud({ action: 'edit', data: newExp });
  };

  const handleDeleteExpense = (id) => {
    if(confirm("確定要刪除這筆紀錄嗎？")) { setExpenses(prev => prev.filter(e => e.id !== id)); setIsEditing(false); syncToCloud({ action: 'delete', id: id }); }
  };

  const triggerCamera = () => { if (fileInputRef.current) fileInputRef.current.click(); };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsScanning(true); setScanStatus('正在解析收據...');
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const aiData = await analyzeReceiptWithGemini(reader.result.split(',')[1], file.type);
          setCurrentExpense({ id: Date.now().toString(), name: aiData.name || '', date: aiData.date || getTodayString(), amountJpy: aiData.amountJpy || '', category: aiData.category || '其他', note: aiData.note || '' });
          setIsScanning(false); setIsEditing(true);
        } catch (error) { alert(error.message); setIsScanning(false); }
      };
      reader.readAsDataURL(file);
    } catch (err) { alert("讀取圖片失敗"); setIsScanning(false); }
    e.target.value = '';
  };

  const renderHome = () => (
    <div className="p-4 space-y-4 animate-in fade-in font-zen pb-10">
      <div className="grid grid-cols-2 gap-3 mb-2">
        <div className="bg-[#fffdf8] border border-[#d4c4a8] border-l-4 border-l-[#c0392b] rounded-xl p-4 shadow-sm">
          <div className="text-[0.7rem] text-[#c0392b] font-bold mb-1">總花費 JPY</div>
          <div className="font-mincho text-2xl font-semibold text-[#1a1209]">¥{formatCurrency(totalJpy)}</div>
        </div>
        <div className="bg-[#fffdf8] border border-[#d4c4a8] border-l-4 border-l-[#2980b9] rounded-xl p-4 shadow-sm">
          <div className="text-[0.7rem] text-[#2980b9] font-bold mb-1">換算 TWD</div>
          <div className="font-mincho text-2xl font-semibold text-[#1a1209]">NT${formatCurrency(totalTwd)}</div>
        </div>
      </div>
      <div onClick={triggerCamera} className="bg-[#fffdf8] border-2 border-dashed border-[#d4c4a8] rounded-2xl p-6 text-center cursor-pointer active:scale-95 shadow-sm">
        <div className="text-4xl mb-2">📷</div>
        <div className="font-bold text-[#1a1209] mb-1">拍攝收據自動記帳</div>
        <div className="text-[0.7rem] text-[#8c7b6b] mt-1">✨ AI自動辨識日期、品項、金額、類別</div>
      </div>
      <div className="bg-[#fffdf8] border border-[#d4c4a8] rounded-2xl p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div><label className="block text-[0.75rem] text-[#1a1209] mb-1">名稱</label><input type="text" value={quickName} onChange={e=>setQuickName(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" /></div>
          <div><label className="block text-[0.75rem] text-[#1a1209] mb-1">金額 (¥)</label><input type="number" value={quickAmount} onChange={e=>setQuickAmount(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div><label className="block text-[0.75rem] text-[#1a1209] mb-1">類別</label><select value={quickCat} onChange={e=>setQuickCat(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]">{CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></div>
          <div><label className="block text-[0.75rem] text-[#1a1209] mb-1">日期</label><input type="date" value={quickDate} onChange={e=>setQuickDate(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" /></div>
        </div>
        <div className="mb-4"><label className="block text-[0.75rem] text-[#1a1209] mb-1">備註 (選填)</label><input type="text" value={quickNote} onChange={e=>setQuickNote(e.target.value)} placeholder="新增備註..." className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" /></div>
        <button onClick={handleQuickAdd} className="w-full bg-[#c0392b] text-white py-3 rounded-xl font-bold tracking-wide active:scale-95 shadow-sm">＋ 新增記帳</button>
      </div>
      {expenses.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[0.8rem] text-[#8c7b6b] font-bold mb-2 ml-1">最近紀錄</h4>
          <div className="space-y-2">
            {sortedExpenses.slice(0, 5).map(exp => (
              <div key={exp.id} onClick={() => { setCurrentExpense(exp); setIsEditing(true); }} className="bg-[#fffdf8] border border-[#d4c4a8] rounded-xl p-3 flex items-center justify-between active:bg-[#f0e8d8] transition-colors">
                <div className="flex-1 overflow-hidden pr-2">
                  <div className="font-bold text-[#1a1209] text-[0.95rem] truncate"><span className="mr-1">{getCategoryEmoji(exp.category)}</span> {exp.name}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-[0.75rem] text-[#8c7b6b] truncate"><span>{exp.date}</span>{exp.note && <span className="truncate opacity-80">· {exp.note}</span>}</div>
                </div>
                <div className="text-[#c0392b] font-bold tracking-wide shrink-0">¥{formatCurrency(exp.amountJpy)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderList = () => (
    <div className="p-4 space-y-2 animate-in fade-in font-zen pb-10">
      {Object.keys(expensesByDate).length === 0 ? <div className="text-center text-[#8c7b6b] mt-20">尚無記帳紀錄</div> : 
        Object.entries(expensesByDate).map(([date, dateExpenses]) => {
          const dayTotalJpy = dateExpenses.reduce((sum, e) => sum + e.amountJpy, 0);
          return (
            <div key={date} className="mb-4">
              <div className="flex justify-between items-end border-b border-[#d4c4a8] pb-1 mb-2 mt-4 ml-1 pr-1">
                <div className="text-[0.8rem] text-[#8c7b6b] font-bold">{date} <span className="text-[0.7rem] font-normal ml-1">({dateExpenses.length}筆)</span></div>
                <div className="text-[0.8rem] text-[#8c7b6b] font-bold">¥{formatCurrency(dayTotalJpy)} <span className="text-[0.7rem] font-normal">/ NT${formatCurrency(Math.round(dayTotalJpy * settings.exchangeRate))}</span></div>
              </div>
              <div className="space-y-2">
                {dateExpenses.map(exp => (
                  <div key={exp.id} onClick={() => { setCurrentExpense(exp); setIsEditing(true); }} className="bg-[#fffdf8] border border-[#d4c4a8] rounded-xl p-3 flex items-center justify-between active:bg-[#f0e8d8] transition-colors">
                    <div className="flex-1 overflow-hidden pr-2">
                      <div className="font-bold text-[#1a1209] text-[0.9rem] flex items-center gap-2 truncate"><span className="text-lg shrink-0">{getCategoryEmoji(exp.category)}</span><span className="truncate">{exp.name}</span></div>
                      {exp.note && <div className="text-[0.75rem] text-[#8c7b6b] mt-0.5 ml-7 truncate opacity-80">{exp.note}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[#c0392b] font-bold tracking-wide">¥{formatCurrency(exp.amountJpy)}</div>
                      <div className="text-[0.7rem] text-[#8c7b6b] mt-0.5">NT${formatCurrency(exp.amountJpy * settings.exchangeRate)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      }
    </div>
  );

  const renderAnalytics = () => {
    const filteredExpenses = expenses.filter(exp => (filterStartDate ? exp.date >= filterStartDate : true) && (filterEndDate ? exp.date <= filterEndDate : true));
    const filteredTotalJpy = filteredExpenses.reduce((sum, e) => sum + e.amountJpy, 0);
    const categoryTotals = CATEGORIES.map(cat => ({ ...cat, amount: filteredExpenses.filter(e => e.category === cat.name).reduce((sum, e) => sum + e.amountJpy, 0) })).filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
    let currentPct = 0;
    const conicGradientStr = categoryTotals.map(cat => {
      const pct = (cat.amount / (filteredTotalJpy || 1)) * 100;
      const start = currentPct;
      const end = currentPct + pct;
      currentPct = end;
      return `${cat.color} ${start}% ${end}%`;
    }).join(', ');

    return (
      <div className="p-4 space-y-4 animate-in fade-in font-zen pb-10">
        <div className="bg-[#fffdf8] p-4 rounded-2xl border border-[#d4c4a8] mt-4 shadow-sm">
          <h3 className="font-bold text-[#1a1209] mb-3 text-[0.9rem]">📅 選擇日期區間</h3>
          <div className="flex items-center gap-2">
            <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-sm focus:outline-none focus:border-[#d4a017]" />
            <span className="text-[#8c7b6b] font-bold">-</span>
            <input type="date" value={filterEndDate} onChange={e => setFilterEndDate(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-sm focus:outline-none focus:border-[#d4a017]" />
          </div>
          {(filterStartDate || filterEndDate) && <button onClick={() => { setFilterStartDate(''); setFilterEndDate(''); }} className="mt-3 w-full py-2 bg-[#f0e8d8] text-[#8c7b6b] rounded-lg text-sm font-bold active:scale-95">清除區間</button>}
        </div>
        {filteredTotalJpy === 0 ? <div className="text-center text-[#8c7b6b] mt-16 bg-[#fffdf8] p-6 rounded-2xl border border-[#d4c4a8]">此區間暫無消費紀錄</div> : (
          <div className="bg-[#fffdf8] p-6 rounded-2xl border border-[#d4c4a8] shadow-sm">
            <h3 className="font-bold text-[#1a1209] mb-8 text-center text-lg">消費類別佔比</h3>
            <div className="flex justify-center mb-8"><div className="w-48 h-48 rounded-full shadow-inner relative" style={{ background: `conic-gradient(${conicGradientStr})` }}><div className="absolute inset-4 bg-[#fffdf8] rounded-full flex items-center justify-center shadow-sm"><div className="text-center"><p className="text-xs text-[#8c7b6b]">區間總計</p><p className="font-mincho font-bold text-[#1a1209] text-sm mt-1">¥{formatCurrency(filteredTotalJpy)}</p></div></div></div></div>
            <div className="space-y-3">{categoryTotals.map(cat => (<div key={cat.name} className="flex items-center justify-between text-[0.95rem]"><div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ backgroundColor: cat.color }}></div><span className="text-[#1a1209] font-medium">{cat.emoji} {cat.name}</span></div><div className="flex gap-4"><span className="font-bold text-[#1a1209]">¥{formatCurrency(cat.amount)}</span><span className="text-[#8c7b6b] w-10 text-right text-xs pt-0.5">{Math.round((cat.amount/filteredTotalJpy)*100)}%</span></div></div>))}</div>
          </div>
        )}
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-4 space-y-6 animate-in fade-in font-zen pb-10">
      <div className="bg-[#fffdf8] border border-[#d4c4a8] rounded-2xl p-5 mt-4 shadow-sm">
        <div className="flex items-center justify-between mb-2"><label className="text-sm font-bold text-[#1a1209]">日圓匯率 (1 JPY = ? TWD)</label><label className="flex items-center gap-1 text-[0.8rem] text-[#2980b9] font-bold"><input type="checkbox" checked={settings.autoRate} onChange={e => setSettings({...settings, autoRate: e.target.checked})} className="w-4 h-4" />自動更新</label></div>
        <input type="number" step="0.0001" disabled={settings.autoRate} value={settings.exchangeRate} onChange={e => setSettings({...settings, exchangeRate: parseFloat(e.target.value) || 0})} className={`w-full p-3 border border-[#d4c4a8] rounded-xl mb-6 focus:outline-none focus:border-[#d4a017] ${settings.autoRate ? 'bg-[#f0e8d8] text-[#8c7b6b]' : 'bg-[#faf6ef]'}`} />
        <label className="block text-sm font-bold text-[#1a1209] mb-2">每日預算 (日圓)</label>
        <input type="number" value={settings.dailyBudgetJpy} onChange={e => setSettings({...settings, dailyBudgetJpy: parseInt(e.target.value) || 0})} className="w-full p-3 border border-[#d4c4a8] rounded-xl bg-[#faf6ef] mb-8 focus:outline-none focus:border-[#d4a017]" />
        <button onClick={() => { if(confirm('清除所有紀錄？')) setExpenses([]); }} className="w-full bg-[#f0e8d8] border border-[#d4c4a8] text-[#c0392b] font-bold py-3 rounded-xl active:scale-95 shadow-sm">🗑️ 清除所有資料</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col w-full max-w-md mx-auto relative shadow-2xl overflow-hidden bg-[#faf6ef]" style={{ height: '100dvh' }}>
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&family=Zen+Kaku+Gothic+New:wght@300;400;700&family=Shippori+Mincho:wght@400;600&display=swap');
        .font-mincho { font-family: 'Shippori Mincho', 'Noto Serif TC', serif; }
        .font-zen { font-family: 'Zen Kaku Gothic New', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 0px; background: transparent; }
        html, body, #root { height: 100%; margin: 0; padding: 0; overflow: hidden; background: #faf6ef; }
      `}} />

      <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleFileChange} className="hidden" />

      {/* Header */}
      <header className="flex-none bg-[#1a1209] text-[#faf6ef] z-10 px-5 py-3 flex justify-between items-center shadow-md h-[60px]">
        <div className="flex items-center gap-2"><span className="text-[1.3rem]">⛩️</span><h1 className="text-[1.15rem] font-mincho font-semibold tracking-wide mt-1">旅費帳本 雲端版</h1></div>
        <div className="flex items-center gap-3">
          {isSyncing ? <span className="text-[#d4a017] text-[0.7rem] font-bold animate-pulse">⏳ 同步中</span> : SCRIPT_URL ? <span className="text-[#27ae60] text-[0.7rem] font-bold">☁️ 雲端</span> : <span className="text-[#8c7b6b] text-[0.7rem] font-bold">📱 本機</span>}
          <div className="text-[#d4a017] text-[0.85rem] font-bold">💴 {settings.exchangeRate}</div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto custom-scrollbar bg-[#faf6ef]">
        {tab === 'home' && renderHome()}
        {tab === 'list' && renderList()}
        {tab === 'analytics' && renderAnalytics()}
        {tab === 'settings' && renderSettings()}
      </main>

      {/* Footer Nav */}
      <nav className="flex-none w-full bg-[#1a1209] flex h-[72px] z-20 shadow-[0_-4px_20px_rgba(0,0,0,0.2)]">
        <NavItem icon="🏠" label="首頁" active={tab === 'home'} onClick={() => setTab('home')} />
        <NavItem icon="📋" label="明細" active={tab === 'list'} onClick={() => setTab('list')} />
        <NavItem icon="📊" label="分析" active={tab === 'analytics'} onClick={() => setTab('analytics')} />
        <NavItem icon="⚙️" label="設定" active={tab === 'settings'} onClick={() => setTab('settings')} />
      </nav>

      {/* Loading Overlay */}
      {isScanning && <div className="absolute inset-0 bg-black/85 z-50 flex flex-col items-center justify-center text-white font-zen gap-4 animate-in fade-in"><div className="w-10 h-10 border-4 border-[#333] border-t-[#d4a017] rounded-full animate-spin"></div><div className="font-bold tracking-wide">🤖 {scanStatus}</div></div>}
      
      {/* Modal */}
      {isEditing && currentExpense && (
        <div className="absolute inset-0 bg-black/60 z-40 flex items-end justify-center animate-in fade-in" onClick={() => setIsEditing(false)}>
          <div className="bg-[#fffdf8] w-full max-w-md rounded-t-[20px] p-6 pb-12 shadow-2xl animate-in slide-in-from-bottom-5 duration-300 font-zen" onClick={e => e.stopPropagation()}>
            <h3 className="mb-4 font-mincho font-bold text-lg text-[#1a1209]">{currentExpense.amountJpy === '' ? '📝 編輯紀錄' : '🤖 確認細項'}</h3>
            <div className="bg-[#f0e8d8] p-4 rounded-xl border border-[#d4c4a8] space-y-3 mb-5">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">日期</label><input type="date" value={currentExpense.date} onChange={e => setCurrentExpense({...currentExpense, date: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] text-sm focus:outline-none" /></div>
                <div><label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">類別</label><select value={currentExpense.category} onChange={e => setCurrentExpense({...currentExpense, category: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] text-sm focus:outline-none">{CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></div>
              </div>
              <div><label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">名稱</label><input type="text" value={currentExpense.name} onChange={e => setCurrentExpense({...currentExpense, name: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] text-sm focus:outline-none" /></div>
              <div><label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">金額 (¥)</label><input type="number" value={currentExpense.amountJpy} onChange={e => setCurrentExpense({...currentExpense, amountJpy: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] text-sm focus:outline-none" /></div>
              <div><label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">備註</label><input type="text" value={currentExpense.note || ''} onChange={e => setCurrentExpense({...currentExpense, note: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] text-sm focus:outline-none" /></div>
            </div>
            <div className="flex gap-2"><button onClick={() => setIsEditing(false)} className="flex-1 bg-[#fffdf8] border border-[#d4c4a8] py-3 rounded-xl font-bold text-[#1a1209]">取消</button><button onClick={handleSaveExpense} className="flex-[2] bg-[#c0392b] text-white py-3 rounded-xl font-bold shadow-md">✅ 確認儲存</button></div>
            {expenses.find(e => e.id === currentExpense.id) && <button onClick={() => handleDeleteExpense(currentExpense.id)} className="w-full mt-4 py-2 text-[#c0392b] font-bold text-sm text-center">🗑️ 刪除紀錄</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// Navigation Item Component
const NavItem = ({ icon, label, active, onClick }) => (
  <button 
    onClick={onClick} 
    className={`flex-1 flex flex-col items-center justify-center border-t-2 transition-all ${active ? 'text-[#d4a017] border-[#d4a017]' : 'text-[#faf6ef]/50 border-transparent'}`}
  >
    <div className="text-xl mb-0.5 leading-none">{icon}</div>
    <span className="text-[0.7rem] font-bold tracking-wider leading-none mt-1">{label}</span>
  </button>
);
