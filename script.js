/* =========================================================================
   CONFIGURAÇÃO DO FIREBASE
   ========================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyCdmEqPzZDR0uxZ-_l8UhiV2eSOYNr5PaM",
  authDomain: "lista-de-aparelhos.firebaseapp.com",
  projectId: "lista-de-aparelhos",
  storageBucket: "lista-de-aparelhos.firebasestorage.app",
  messagingSenderId: "67152136182",
  appId: "1:67152136182:web:6f92152c7a5e01ba2069d7"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* =========================================================================
   ESTADO GLOBAL
   ========================================================================= */
let currentUser = null;        // objeto do Firebase Auth
let currentUserDoc = null;     // documento em /users/{uid}
let isMasterUser = false;
let myStoreId = null;          // loja do usuário logado (null para master sem loja própria)
let filtroCategoriaAtivo = 'Todas';       // filtro de categoria da aba "Loja Atual"
let filtroCategoriaAtivoTodas = 'Todas';  // filtro de categoria da aba "Todos os Aparelhos"

let lojasMap = {};              // { storeId: {id, name, active, ownerUid} }
let devicesCache = [];          // aparelhos da loja atual (aba 1)
let devicesCacheTodas = [];     // aparelhos de todas as lojas (aba 2)
let usuariosCache = [];
let historicoCache = [];
let transferenciasRecebidas = [];
let transferenciasEnviadas = [];
let vendaDeviceId = null, transferenciaDeviceId = null, editarDeviceId = null;

let unsubLojas = null, unsubDevices = null, unsubDevicesTodas = null, unsubUsuarios = null, unsubRecebidas = null, unsubEnviadas = null;

const CATEGORIAS = ['NOVO','NOVO DE VITRINE','SEMI-NOVO','OUTLET','LACRADO','USO LOJA','RASTREIO'];
const categoriaClass = {'NOVO':'cat-novo','NOVO DE VITRINE':'cat-vitrine','SEMI-NOVO':'cat-semi','OUTLET':'cat-outlet','LACRADO':'cat-lacrado','USO LOJA':'cat-uso','RASTREIO':'cat-rastreio'};
const categoriaRowClass = {'NOVO':'linha-novo','NOVO DE VITRINE':'linha-vitrine','SEMI-NOVO':'linha-semi','OUTLET':'linha-outlet','LACRADO':'linha-lacrado','USO LOJA':'linha-uso','RASTREIO':'linha-rastreio'};

/* =========================================================================
   HELPERS
   ========================================================================= */
function formatarDataHoraSP(date){
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  }).format(date);
}
function formatarDataSP(date){
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date);
  const obj = {};
  partes.forEach(p=>obj[p.type]=p.value);
  return `${obj.year}-${obj.month}-${obj.day}`;
}
function valor(id){ const el=document.getElementById(id); return el ? el.value.trim() : ''; }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function buscarDevice(id){ return devicesCache.find(x=>x.id===id) || devicesCacheTodas.find(x=>x.id===id); }

/* =========================================================================
   MÁSCARA DE MOEDA (R$) — identifica ponto/vírgula e formata em tempo real
   ========================================================================= */
function formatarCentavosParaReal(digitos){
  let d = digitos.replace(/\D/g,'').replace(/^0+(?=\d)/,'');
  if (!d) return '';
  while (d.length < 3) d = '0'+d;
  const centavos = d.slice(-2);
  const inteiro = d.slice(0,-2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${inteiro},${centavos}`;
}
function aplicarMascaraMoeda(el){
  if (!el || el.dataset.mascaraMoeda) return;
  el.dataset.mascaraMoeda = '1';
  el.addEventListener('input', ()=>{
    const posicaoOriginal = el.value.length;
    el.value = formatarCentavosParaReal(el.value);
    // mantém o cursor no fim, já que a máscara reconstrói o valor inteiro
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(el.value.length, el.value.length);
    void posicaoOriginal;
  });
  el.setAttribute('inputmode','numeric');
}
function inicializarMascarasMoeda(){
  ['avista','cinco','dez','dezoito','editarAvista','editarCinco','editarDez','editarDezoito']
    .forEach(id=>aplicarMascaraMoeda(document.getElementById(id)));
}
document.addEventListener('DOMContentLoaded', inicializarMascarasMoeda);
if (document.readyState !== 'loading') inicializarMascarasMoeda();

window.addEventListener('beforeprint', ()=>{
  document.getElementById('wrapperTabelaLojaAtual')?.classList.add('modo-print');
});
window.addEventListener('afterprint', ()=>{
  document.getElementById('wrapperTabelaLojaAtual')?.classList.remove('modo-print');
});

async function capturarTabela(){
  const wrap = document.getElementById('wrapperTabelaLojaAtual');
  const btn = document.getElementById('btnCapturarTabela');
  if (!wrap) return;
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturando...';
  wrap.classList.add('modo-print');

  const nomeLoja = myStoreId ? (lojasMap[myStoreId]?.name || 'Loja') : (isMasterUser ? 'Acesso master — todas as lojas' : 'Sem loja associada');
  const cabecalho = document.createElement('div');
  cabecalho.id = 'capturaCabecalho';
  cabecalho.style.cssText = 'padding:12px 16px;background:#fff;border-bottom:2px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:800;color:var(--text);';
  cabecalho.innerHTML = `<span><i class="fa-solid fa-store" style="color:var(--accent);"></i> ${escapeHtml(nomeLoja)}</span><span style="font-weight:700;color:var(--text-muted);">Capturado em ${formatarDataHoraSP(new Date())}</span>`;
  wrap.prepend(cabecalho);

  try{
    const canvas = await html2canvas(wrap, { backgroundColor:'#ffffff', scale:2 });
    const link = document.createElement('a');
    link.download = `tabela-aparelhos-${formatarDataSP(new Date())}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('Imagem da tabela gerada com sucesso.','success');
  }catch(err){
    showToast('Erro ao capturar tabela: '+err.message,'error');
  }finally{
    cabecalho.remove();
    wrap.classList.remove('modo-print');
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

function showToast(msg, tipo='info'){
  const cont = document.getElementById('toastContainer');
  const el = document.createElement('div');
  const icones = {success:'fa-circle-check',error:'fa-circle-xmark',warning:'fa-triangle-exclamation',info:'fa-circle-info'};
  el.className = 'toast toast-'+tipo;
  el.innerHTML = `<i class="fa-solid ${icones[tipo]||icones.info}"></i><span>${escapeHtml(msg)}</span>`;
  cont.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(),300); }, 4000);
}

function traduzErro(err){
  const map = {
    'auth/email-already-in-use':'Este e-mail já está cadastrado.',
    'auth/invalid-email':'E-mail inválido.',
    'auth/weak-password':'A senha deve ter ao menos 6 caracteres.',
    'auth/wrong-password':'Senha incorreta.',
    'auth/user-not-found':'Usuário não encontrado.',
    'auth/invalid-credential':'E-mail ou senha incorretos.',
    'auth/too-many-requests':'Muitas tentativas. Aguarde um momento e tente novamente.'
  };
  return map[err.code] || ('Erro: ' + err.message);
}

function toggleManual(inputId){
  const select = document.getElementById(inputId+'Select');
  const input = document.getElementById(inputId);
  if (!select || !input) return;
  if (select.value === '__manual__'){ input.style.display=''; input.value=''; input.focus(); }
  else { input.style.display='none'; input.value = select.value; }
}
function aplicarValorSelect(inputId, valorAtual){
  const select = document.getElementById(inputId+'Select');
  const input = document.getElementById(inputId);
  if (!select || !input) return;
  const v = (valorAtual||'').toString().trim();
  const opcoes = Array.from(select.options).map(o=>o.value);
  if (v && opcoes.includes(v)){ select.value=v; input.style.display='none'; input.value=v; }
  else if (v){ select.value='__manual__'; input.style.display=''; input.value=v; }
  else { select.value=''; input.style.display='none'; input.value=''; }
}
function valorSelectOuManual(id){
  const select = document.getElementById(id+'Select');
  if (!select) return valor(id);
  return select.value === '__manual__' ? valor(id) : (select.value || valor(id));
}

function mostrarTela(nome){
  document.getElementById('telaCarregando').classList.add('hidden');
  document.getElementById('telaAuth').classList.toggle('hidden', nome!=='auth');
  document.getElementById('telaSetupLoja').classList.toggle('hidden', nome!=='setupLoja');
  document.getElementById('telaApp').classList.toggle('hidden', nome!=='app');
}

function mostrarAbaAuth(nome){
  document.getElementById('btnAbaLogin').classList.toggle('active', nome==='login');
  document.getElementById('btnAbaRegistro').classList.toggle('active', nome==='registro');
  document.getElementById('formLogin').classList.toggle('hidden', nome!=='login');
  document.getElementById('formRegistro').classList.toggle('hidden', nome!=='registro');
}

function mostrarAba(nome){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===nome));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active', c.id==='tab-'+nome));
}

function toggleFormCadastro(){
  const card = document.getElementById('cardCadastroAparelho');
  const abrindo = card.classList.contains('hidden');
  card.classList.toggle('hidden');
  if (abrindo) card.scrollIntoView({ behavior:'smooth', block:'start' });
}
function fecharFormCadastro(){
  document.getElementById('cardCadastroAparelho').classList.add('hidden');
  document.getElementById('formAparelho').reset();
}

function abrirPainel(boxId){
  document.querySelectorAll('.painel-box').forEach(b=>b.style.display='none');
  document.getElementById(boxId).style.display='flex';
  document.getElementById('painelOverlay').classList.add('active');
  document.getElementById('painelLateral').classList.add('active');
}
function fecharPainel(){
  document.getElementById('painelOverlay').classList.remove('active');
  document.getElementById('painelLateral').classList.remove('active');
}
document.addEventListener('keydown', e=>{ if (e.key==='Escape') fecharPainel(); });

/* =========================================================================
   AUTENTICAÇÃO
   ========================================================================= */
document.getElementById('formLogin').addEventListener('submit', async e=>{
  e.preventDefault();
  try{ await auth.signInWithEmailAndPassword(valor('loginEmail'), document.getElementById('loginSenha').value); }
  catch(err){ showToast(traduzErro(err),'error'); }
});

document.getElementById('formRegistro').addEventListener('submit', async e=>{
  e.preventDefault();
  const email = valor('regEmail');
  const senha = document.getElementById('regSenha').value;
  const senha2 = document.getElementById('regSenha2').value;
  if (senha !== senha2){ showToast('As senhas não coincidem.','warning'); return; }
  if (senha.length < 6){ showToast('A senha deve ter ao menos 6 caracteres.','warning'); return; }
  try{ await auth.createUserWithEmailAndPassword(email, senha); }
  catch(err){ showToast(traduzErro(err),'error'); }
});

function recuperarSenha(){
  const email = prompt('Digite seu e-mail para receber o link de redefinição de senha:');
  if (!email) return;
  auth.sendPasswordResetEmail(email)
    .then(()=>showToast('E-mail de redefinição enviado!','success'))
    .catch(err=>showToast(traduzErro(err),'error'));
}

function sair(){ limparListeners(); auth.signOut(); }

document.getElementById('formSetupLoja').addEventListener('submit', async e=>{
  e.preventDefault();
  const nome = valor('setupNomeLoja');
  if (!nome){ showToast('Informe o nome da loja.','warning'); return; }
  try{
    const storeRef = db.collection('stores').doc();
    await storeRef.set({ name: nome, ownerUid: currentUser.uid, active:true, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    await db.collection('users').doc(currentUser.uid).set({
      email: currentUser.email, role:'padrao', storeId: storeRef.id, active:true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('Loja configurada com sucesso!','success');
    location.reload();
  }catch(err){ showToast('Erro ao configurar loja: '+err.message,'error'); }
});

auth.onAuthStateChanged(async user=>{
  limparListeners();
  if (!user){ currentUser=null; currentUserDoc=null; mostrarTela('auth'); return; }
  currentUser = user;
  try{
    const snap = await db.collection('users').doc(user.uid).get();
    if (!snap.exists){ mostrarTela('setupLoja'); return; }
    currentUserDoc = snap.data();
    if (currentUserDoc.active === false){
      showToast('Sua conta foi desativada. Contate o administrador master.','error');
      auth.signOut();
      return;
    }
    if (currentUserDoc.role !== 'master' && !currentUserDoc.storeId){ mostrarTela('setupLoja'); return; }

    isMasterUser = currentUserDoc.role === 'master';
    myStoreId = currentUserDoc.storeId || null;

    document.getElementById('badgePapel').textContent = isMasterUser ? 'Master' : 'Padrão';
    document.getElementById('badgePapel').className = 'badge ' + (isMasterUser?'badge-purple':'badge-info');
    document.getElementById('emailUsuario').textContent = currentUser.email;
    document.querySelectorAll('[data-master-only]').forEach(el=> el.classList.toggle('hidden', !isMasterUser));
    document.getElementById('wrapLojaCadastro').classList.toggle('hidden', !isMasterUser);
    document.getElementById('btnEditarNomeLoja').classList.toggle('hidden', !myStoreId);

    mostrarTela('app');
    renderChipsCategoriaAtual();
    renderChipsCategoriaTodas();
    iniciarListeners();
  }catch(err){
    showToast('Erro ao carregar dados do usuário: '+err.message,'error');
    mostrarTela('auth');
  }
});

function limparListeners(){
  [unsubLojas,unsubDevices,unsubDevicesTodas,unsubUsuarios,unsubRecebidas,unsubEnviadas].forEach(u=>{ if (u) u(); });
  unsubLojas=unsubDevices=unsubDevicesTodas=unsubUsuarios=unsubRecebidas=unsubEnviadas=null;
}

/* =========================================================================
   LISTENERS PRINCIPAIS
   ========================================================================= */
function iniciarListeners(){
  unsubLojas = db.collection('stores').onSnapshot(snap=>{
    lojasMap = {};
    snap.forEach(doc=> lojasMap[doc.id] = { id: doc.id, ...doc.data() });
    atualizarSelectsLojas();
    atualizarPillLoja();
    renderTabelaLojasAdmin();
    renderTabelaTodasLojas();
    iniciarListenerAparelhos();
  }, err=>showToast('Erro ao carregar lojas: '+err.message,'error'));

  iniciarListenerTransferencias();

  if (isMasterUser){
    unsubUsuarios = db.collection('users').onSnapshot(snap=>{
      usuariosCache = [];
      snap.forEach(doc=> usuariosCache.push({ id: doc.id, ...doc.data() }));
      renderTabelaUsuariosAdmin();
    }, err=>showToast('Erro ao carregar usuários: '+err.message,'error'));
  }
}

function atualizarPillLoja(){
  const nome = myStoreId ? (lojasMap[myStoreId]?.name || 'Loja') : (isMasterUser ? 'Acesso master — todas as lojas' : 'Sem loja');
  document.getElementById('pillLojaAtual').textContent = nome;
  const spanTabela = document.getElementById('nomeLojaAtualTabela');
  if (spanTabela) spanTabela.textContent = myStoreId ? (lojasMap[myStoreId]?.name || 'Loja') : 'Sem loja associada';
}

function atualizarSelectsLojas(){
  const ativos = Object.values(lojasMap).filter(l=>l.active!==false).sort((a,b)=>(a.name||'').localeCompare(b.name||''));

  const opts = ativos.map(l=>`<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  const selCad = document.getElementById('selectLojaCadastro');
  if (selCad){ selCad.innerHTML = `<option value="">— Selecione a loja —</option>` + opts; }

  const selHist = document.getElementById('selectLojaHistorico');
  if (selHist){ selHist.innerHTML = `<option value="">Todas as lojas</option>` + opts; }
}

function preencherSelectLojasDestino(selectId, excluirStoreId){
  const el = document.getElementById(selectId);
  const ativos = Object.values(lojasMap).filter(l=>l.active!==false && l.id!==excluirStoreId).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  el.innerHTML = `<option value="">— Selecione a loja destino —</option>` + ativos.map(l=>`<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
}

/* =========================================================================
   ABA CADASTRAR
   ========================================================================= */
document.getElementById('formAparelho').addEventListener('submit', async e=>{
  e.preventDefault();
  const lojaAlvo = isMasterUser ? valor('selectLojaCadastro') : myStoreId;
  if (!lojaAlvo){ showToast('Selecione a loja de destino.','warning'); return; }
  const nome = valor('nome');
  if (!nome){ showToast('Informe o nome do aparelho.','warning'); return; }

  const dados = {
    storeId: lojaAlvo,
    nome, imei: valor('imei'),
    armazenamento: valorSelectOuManual('armazenamento'),
    ram: valorSelectOuManual('ram'),
    nfc: valor('nfc'), garantia: valor('garantia'), categoria: valor('categoria') || 'NOVO',
    avista: valor('avista'), cinco: valor('cinco'), dez: valor('dez'), dezoito: valor('dezoito'),
    observacao: valor('observacao'),
    status: 'disponivel', pendingDestStoreId: null, pendingTransferId: null,
    createdByUid: currentUser.uid, createdByEmail: currentUser.email,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  try{
    await db.collection('devices').add(dados);
    await registrarHistorico([lojaAlvo], 'Cadastro', dados, `Aparelho cadastrado: ${nome}`);
    fecharFormCadastro();
    showToast('Aparelho cadastrado!','success');
  }catch(err){ showToast('Erro ao cadastrar: '+err.message,'error'); }
});

/* =========================================================================
   ABA APARELHOS
   ========================================================================= */
function iniciarListenerAparelhos(){
  // ---- Aba 1: aparelhos da loja atual ----
  if (unsubDevices) unsubDevices();
  if (!myStoreId){
    devicesCache = [];
    renderChipsCategoriaAtual();
    renderTabelaLojaAtual();
    atualizarStats();
  } else {
    unsubDevices = db.collection('devices').where('storeId','==', myStoreId)
      .onSnapshot(snap=>{
        devicesCache = [];
        snap.forEach(doc=> devicesCache.push({ id: doc.id, ...doc.data() }));
        renderChipsCategoriaAtual();
        renderTabelaLojaAtual();
        atualizarStats();
      }, err=>showToast('Erro ao carregar aparelhos: '+err.message,'error'));
  }

  // ---- Aba 2: aparelhos de todas as lojas ----
  if (unsubDevicesTodas) unsubDevicesTodas();
  unsubDevicesTodas = db.collection('devices')
    .onSnapshot(snap=>{
      devicesCacheTodas = [];
      snap.forEach(doc=> devicesCacheTodas.push({ id: doc.id, ...doc.data() }));
      renderChipsCategoriaTodas();
      renderTabelaTodasLojas();
    }, err=>showToast('Erro ao carregar aparelhos: '+err.message,'error'));
}

function renderChipsCategoriaGenerico(containerId, cache, filtroAtual, chipVendidosId, onFiltrar, onToggleVendidos){
  const cont = document.getElementById(containerId);
  if (!cont) return;
  const presentes = CATEGORIAS.filter(c => cache.some(d=>d.categoria===c));
  const cats = ['Todas', ...presentes];
  cont.innerHTML = cats.map(c=>`<button type="button" class="filter-chip ${filtroAtual===c?'active':''}" onclick="${onFiltrar}('${c}')">${c}</button>`).join('');
}

function renderChipsCategoriaAtual(){
  if (filtroCategoriaAtivo !== 'Todas' && !devicesCache.some(d=>d.categoria===filtroCategoriaAtivo)) filtroCategoriaAtivo = 'Todas';
  renderChipsCategoriaGenerico('chipsCategoria', devicesCache, filtroCategoriaAtivo, 'chipVendidos', 'filtrarCategoriaAtual', 'toggleChipVendidosAtual');
}
function filtrarCategoriaAtual(c){ filtroCategoriaAtivo=c; renderChipsCategoriaAtual(); renderTabelaLojaAtual(); }
function toggleChipVendidosAtual(btn){ btn.classList.toggle('active'); renderTabelaLojaAtual(); }

function renderChipsCategoriaTodas(){
  if (filtroCategoriaAtivoTodas !== 'Todas' && !devicesCacheTodas.some(d=>d.categoria===filtroCategoriaAtivoTodas)) filtroCategoriaAtivoTodas = 'Todas';
  renderChipsCategoriaGenerico('chipsCategoriaTodas', devicesCacheTodas, filtroCategoriaAtivoTodas, 'chipVendidosTodas', 'filtrarCategoriaTodas', 'toggleChipVendidosTodas');
}
function filtrarCategoriaTodas(c){ filtroCategoriaAtivoTodas=c; renderChipsCategoriaTodas(); renderTabelaTodasLojas(); }
function toggleChipVendidosTodas(btn){ btn.classList.toggle('active'); renderTabelaTodasLojas(); }

function linhaAparelho(d, comLoja, comAcoes){
  const podeEditar = isMasterUser || d.storeId === myStoreId;
  const statusBadge = d.status==='vendido' ? '<span class="badge badge-muted">Vendido</span>'
    : d.status==='transfer_pendente' ? '<span class="badge badge-warning">Transf. pendente</span>'
    : '<span class="badge badge-success">Disponível</span>';

  let acaoCell = '';
  if (comAcoes){
    let acoes = '<span class="texto-soft">Somente leitura</span>';
    if (podeEditar){
      if (d.status==='transfer_pendente'){
        acoes = `<button class="btn-ghost btn-icon" onclick="cancelarTransferencia('${d.pendingTransferId}')" title="Cancelar transferência"><i class="fa-solid fa-ban"></i></button>`;
      } else {
        acoes = `<div class="acao-select-wrap"><select class="select-acao" onchange="acaoAparelho(this,'${d.id}')">
          <option value="">Ações</option>
          <option value="vender">Vender</option>
          <option value="transferir">Transferir</option>
          <option value="editar">Editar</option>
          <option value="copiar">Copiar informações</option>
          <option value="excluir">Excluir</option>
        </select></div>`;
      }
    }
    acaoCell = `<td class="col-acoes">${acoes}</td>`;
  }

  const lojaCell = comLoja ? `<td>${escapeHtml(lojasMap[d.storeId]?.name || '—')}</td>` : '';

  return `<tr>
    ${lojaCell}
    <td><strong>${escapeHtml(d.nome||'')}</strong></td>
    <td class="imei-cell">${escapeHtml(d.imei||'—')}</td>
    <td>${escapeHtml(d.armazenamento||'—')}</td>
    <td>${escapeHtml(d.ram||'—')}</td>
    <td>${d.nfc==='Sim' ? '<span class="nfc-yes">Sim</span>' : '<span class="nfc-no">Não</span>'}</td>
    <td>${escapeHtml(d.garantia||'—')}</td>
    <td class="price-cell">${escapeHtml(d.avista||'—')}</td>
    <td class="price-cell">${escapeHtml(d.cinco||'—')}</td>
    <td class="price-cell">${escapeHtml(d.dez||'—')}</td>
    <td class="price-cell">${escapeHtml(d.dezoito||'—')}</td>
    <td class="cell-observacao" title="${escapeHtml(d.observacao||'')}">${escapeHtml(d.observacao||'—')}</td>
    <td>${statusBadge}</td>
    ${acaoCell}
  </tr>`;
}

function theadAparelhos(comLoja, comAcoes){
  const lojaTh = comLoja ? '<th>Loja</th>' : '';
  const acoesTh = comAcoes ? '<th class="col-acoes" style="width:120px;">Ações</th>' : '';
  return `<tr>${lojaTh}<th>Aparelho</th><th>IMEI</th><th>Armaz.</th><th>RAM</th><th>NFC</th>
    <th>Garantia</th><th>À vista</th><th>5x</th><th>10x</th><th>18x</th><th>Observação</th><th>Status</th>${acoesTh}</tr>`;
}

function renderTabelaAgrupadaPorCategoria(containerId, lista, comLoja, comAcoes){
  const cont = document.getElementById(containerId);
  if (!cont) return;
  if (lista.length===0){
    cont.innerHTML = `<div class="empty"><i class="fa-solid fa-inbox"></i>Nenhum aparelho encontrado.</div>`;
    return;
  }

  const presentes = CATEGORIAS.filter(c=>lista.some(d=>d.categoria===c));
  const extras = [...new Set(lista.map(d=>d.categoria).filter(c=>c && !CATEGORIAS.includes(c)))].sort();
  const grupos = [...presentes, ...extras];

  let html = '';
  grupos.forEach(cat=>{
    const itens = lista.filter(d=>d.categoria===cat);
    if (!itens.length) return;
    html += `<div class="subtabela-categoria ${categoriaRowClass[cat]||''}">
      <div class="subtabela-header"><span class="category-badge ${categoriaClass[cat]||''}">${escapeHtml(cat)}</span> <span class="subtabela-count">(${itens.length})</span></div>
      <table><thead>${theadAparelhos(comLoja, comAcoes)}</thead><tbody>${itens.map(d=>linhaAparelho(d, comLoja, comAcoes)).join('')}</tbody></table>
    </div>`;
  });

  const semCategoria = lista.filter(d=>!d.categoria);
  if (semCategoria.length){
    html += `<div class="subtabela-categoria">
      <div class="subtabela-header">Sem categoria <span class="subtabela-count">(${semCategoria.length})</span></div>
      <table><thead>${theadAparelhos(comLoja, comAcoes)}</thead><tbody>${semCategoria.map(d=>linhaAparelho(d, comLoja, comAcoes)).join('')}</tbody></table>
    </div>`;
  }

  cont.innerHTML = html;
}

function renderTabelaLojaAtual(){
  const busca = (document.getElementById('buscaAparelho')?.value||'').toLowerCase().trim();

  const lista = devicesCache.filter(d=>{
    if (d.status==='vendido') return false;
    if (filtroCategoriaAtivo !== 'Todas' && d.categoria !== filtroCategoriaAtivo) return false;
    if (busca){
      const alvo = [d.nome,d.imei,d.observacao,d.garantia].filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  renderTabelaAgrupadaPorCategoria('corpoTabelaAparelhosAtual', lista, false, true);
}

function renderTabelaTodasLojas(){
  const busca = (document.getElementById('buscaAparelhoTodas')?.value||'').toLowerCase().trim();

  const lista = devicesCacheTodas.filter(d=>{
    if (d.status==='vendido') return false;
    if (filtroCategoriaAtivoTodas !== 'Todas' && d.categoria !== filtroCategoriaAtivoTodas) return false;
    if (busca){
      const alvo = [d.nome,d.imei,d.observacao,d.garantia,lojasMap[d.storeId]?.name].filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  renderTabelaAgrupadaPorCategoria('corpoTabelaAparelhosTodas', lista, true, false);
}

function acaoAparelho(select, deviceId){
  const val = select.value; select.value='';
  if (val==='vender') abrirVenda(deviceId);
  else if (val==='transferir') abrirTransferencia(deviceId);
  else if (val==='editar') abrirEditar(deviceId);
  else if (val==='copiar') copiarInfoAparelho(deviceId);
  else if (val==='excluir') excluirAparelho(deviceId);
}

function atualizarStats(){
  document.getElementById('statTotal').textContent = devicesCache.length;
  document.getElementById('statDisponivel').textContent = devicesCache.filter(d=>d.status==='disponivel').length;
  document.getElementById('statVendido').textContent = devicesCache.filter(d=>d.status==='vendido').length;
  document.getElementById('statTransferPendente').textContent = devicesCache.filter(d=>d.status==='transfer_pendente').length;
}

/* =========================================================================
   HISTÓRICO (registro de eventos)
   ========================================================================= */
async function registrarHistorico(visibleTo, tipo, deviceSnapshot, detalhe, extra={}){
  await db.collection('history').add({
    visibleTo, tipo, detalhe,
    device: {
      nome: deviceSnapshot.nome||'', imei: deviceSnapshot.imei||'', categoria: deviceSnapshot.categoria||'',
      garantia: deviceSnapshot.garantia||'', avista: deviceSnapshot.avista||'', cinco: deviceSnapshot.cinco||'',
      dez: deviceSnapshot.dez||'', dezoito: deviceSnapshot.dezoito||''
    },
    extra,
    userUid: currentUser.uid, userEmail: currentUser.email,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

/* =========================================================================
   VENDA
   ========================================================================= */
function abrirVenda(deviceId){
  vendaDeviceId = deviceId;
  ['vendaCliente','vendaCpfCnpj','vendaTelefone','vendaVendedor','vendaNumeroPedido','vendaNumeroCcb'].forEach(id=>document.getElementById(id).value='');
  abrirPainel('boxVenda');
}
async function confirmarVenda(){
  const d = buscarDevice(vendaDeviceId);
  if (!d) return;
  const cliente=valor('vendaCliente'), cpf=valor('vendaCpfCnpj'), tel=valor('vendaTelefone'), vendedor=valor('vendaVendedor'),
        numeroPedido=valor('vendaNumeroPedido'), numeroCcb=valor('vendaNumeroCcb');
  if (!cliente||!cpf||!tel||!vendedor||!numeroPedido){ showToast('Preencha todos os campos obrigatórios.','warning'); return; }
  try{
    await db.collection('devices').doc(d.id).update({ status:'vendido', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await registrarHistorico([d.storeId], 'Venda', d, `Vendido para ${cliente} (CPF/CNPJ ${cpf}) pelo vendedor ${vendedor} · Pedido nº ${numeroPedido}${numeroCcb?` · CCB nº ${numeroCcb}`:''}`, { cliente, cpf, telefone: tel, vendedor, numeroPedido, numeroCcb });
    fecharPainel();
    showToast('Venda registrada!','success');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

/* =========================================================================
   TRANSFERÊNCIA
   ========================================================================= */
function abrirTransferencia(deviceId){
  const d = buscarDevice(deviceId);
  if (!d) return;
  transferenciaDeviceId = deviceId;
  document.getElementById('transfDeviceInfo').textContent = `${d.nome} · IMEI ${d.imei||'—'}`;
  preencherSelectLojasDestino('selectLojaDestino', d.storeId);
  document.getElementById('transfVendedor').value='';
  document.getElementById('transfEntregador').value='';
  abrirPainel('boxTransferencia');
}

async function confirmarTransferencia(){
  const destStoreId = valor('selectLojaDestino');
  const vendedor = valor('transfVendedor');
  const entregador = valor('transfEntregador');
  if (!destStoreId || !vendedor || !entregador){ showToast('Preencha todos os campos.','warning'); return; }
  const d = buscarDevice(transferenciaDeviceId);
  if (!d) return;
  const originStoreId = d.storeId;
  try{
    const transferRef = db.collection('transfers').doc();
    await transferRef.set({
      deviceId: d.id,
      deviceSnapshot: { nome:d.nome||'', imei:d.imei||'', categoria:d.categoria||'', garantia:d.garantia||'' },
      originStoreId, originStoreName: lojasMap[originStoreId]?.name||'',
      destStoreId, destStoreName: lojasMap[destStoreId]?.name||'',
      vendedor, entregador, status:'pendente',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdByUid: currentUser.uid, createdByEmail: currentUser.email
    });
    await db.collection('devices').doc(d.id).update({
      status:'transfer_pendente', pendingDestStoreId: destStoreId, pendingTransferId: transferRef.id,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registrarHistorico([originStoreId], 'Transferência solicitada', d, `Solicitada transferência para ${lojasMap[destStoreId]?.name||''} (vendedor: ${vendedor}, entregador: ${entregador})`);
    fecharPainel();
    showToast('Transferência solicitada! Aguardando aprovação da loja destino.','success');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

async function cancelarTransferencia(transferId){
  if (!confirm('Cancelar esta solicitação de transferência?')) return;
  try{
    const tRef = db.collection('transfers').doc(transferId);
    const tSnap = await tRef.get();
    const t = tSnap.data();
    if (!t || t.status !== 'pendente'){ showToast('Não é possível cancelar (já foi respondida).','warning'); return; }
    await db.collection('devices').doc(t.deviceId).update({ status:'disponivel', pendingDestStoreId:null, pendingTransferId:null, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await tRef.update({ status:'cancelada', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await registrarHistorico([t.originStoreId], 'Transferência cancelada', t.deviceSnapshot, 'Solicitação cancelada pela loja de origem.');
    showToast('Transferência cancelada.','info');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

async function aprovarTransferencia(transferId){
  if (!confirm('Confirmar recebimento deste aparelho?')) return;
  try{
    const tRef = db.collection('transfers').doc(transferId);
    const tSnap = await tRef.get();
    const t = tSnap.data();
    if (!t || t.status !== 'pendente'){ showToast('Esta transferência já foi respondida.','warning'); return; }
    await db.collection('devices').doc(t.deviceId).update({
      storeId: t.destStoreId, status:'disponivel', pendingDestStoreId:null, pendingTransferId:null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await tRef.update({ status:'aprovada', respondedAt: firebase.firestore.FieldValue.serverTimestamp(), respondedByUid: currentUser.uid });
    await registrarHistorico([t.originStoreId], 'Transferência aprovada', t.deviceSnapshot, `${t.destStoreName} confirmou o recebimento do aparelho.`);
    await registrarHistorico([t.destStoreId], 'Transferência recebida', t.deviceSnapshot, `Aparelho recebido de ${t.originStoreName}.`);
    showToast('Transferência aprovada!','success');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

async function recusarTransferencia(transferId){
  if (!confirm('Recusar esta transferência? O aparelho voltará para a loja de origem.')) return;
  try{
    const tRef = db.collection('transfers').doc(transferId);
    const tSnap = await tRef.get();
    const t = tSnap.data();
    if (!t || t.status !== 'pendente'){ showToast('Esta transferência já foi respondida.','warning'); return; }
    await db.collection('devices').doc(t.deviceId).update({ status:'disponivel', pendingDestStoreId:null, pendingTransferId:null, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await tRef.update({ status:'recusada', respondedAt: firebase.firestore.FieldValue.serverTimestamp(), respondedByUid: currentUser.uid });
    await registrarHistorico([t.originStoreId], 'Transferência recusada', t.deviceSnapshot, `${t.destStoreName} recusou o recebimento do aparelho.`);
    showToast('Transferência recusada.','info');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

function iniciarListenerTransferencias(){
  if (unsubRecebidas) unsubRecebidas();
  if (unsubEnviadas) unsubEnviadas();

  const qRecebidas = isMasterUser
    ? db.collection('transfers').where('status','==','pendente')
    : (myStoreId ? db.collection('transfers').where('destStoreId','==', myStoreId).where('status','==','pendente') : null);

  if (qRecebidas){
    unsubRecebidas = qRecebidas.onSnapshot(snap=>{
      transferenciasRecebidas = [];
      snap.forEach(doc=>transferenciasRecebidas.push({id:doc.id, ...doc.data()}));
      renderTransferenciasRecebidas();
    }, err=>showToast('Erro ao carregar transferências: '+err.message,'error'));
  }

  const qEnviadas = isMasterUser
    ? db.collection('transfers').orderBy('createdAt','desc').limit(100)
    : (myStoreId ? db.collection('transfers').where('originStoreId','==', myStoreId).orderBy('createdAt','desc').limit(100) : null);

  if (qEnviadas){
    unsubEnviadas = qEnviadas.onSnapshot(snap=>{
      transferenciasEnviadas = [];
      snap.forEach(doc=>transferenciasEnviadas.push({id:doc.id, ...doc.data()}));
      renderTransferenciasEnviadas();
    }, err=>showToast('Erro ao carregar transferências: '+err.message,'error'));
  }
}

function renderTransferenciasRecebidas(){
  const cont = document.getElementById('listaTransferenciasRecebidas');
  const badge = document.getElementById('badgeTransfPend');
  if (transferenciasRecebidas.length===0){
    cont.innerHTML = '<p class="texto-soft">Nenhuma transferência pendente.</p>';
    badge.classList.add('hidden');
    return;
  }
  badge.textContent = transferenciasRecebidas.length;
  badge.classList.remove('hidden');
  cont.innerHTML = transferenciasRecebidas.map(t=>`
    <div class="card" style="margin-bottom:10px;padding:14px 16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <strong>${escapeHtml(t.deviceSnapshot?.nome||'')}</strong> · IMEI ${escapeHtml(t.deviceSnapshot?.imei||'—')}<br/>
          <span class="texto-soft">De: ${escapeHtml(t.originStoreName)} · Vendedor: ${escapeHtml(t.vendedor)} · Entregador: ${escapeHtml(t.entregador)}</span>
        </div>
        <div class="actions" style="margin:0;">
          <button class="btn-primary btn-icon" onclick="aprovarTransferencia('${t.id}')" title="Aprovar"><i class="fa-solid fa-check"></i></button>
          <button class="btn-danger btn-icon" onclick="recusarTransferencia('${t.id}')" title="Recusar"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
    </div>`).join('');
}

function renderTransferenciasEnviadas(){
  const cont = document.getElementById('listaTransferenciasEnviadas');
  if (transferenciasEnviadas.length===0){ cont.innerHTML = '<p class="texto-soft">Nenhuma transferência enviada.</p>'; return; }
  const statusBadge = {pendente:'badge-warning',aprovada:'badge-success',recusada:'badge-muted',cancelada:'badge-muted'};
  cont.innerHTML = transferenciasEnviadas.map(t=>`
    <div class="card" style="margin-bottom:10px;padding:14px 16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <strong>${escapeHtml(t.deviceSnapshot?.nome||'')}</strong> · IMEI ${escapeHtml(t.deviceSnapshot?.imei||'—')}<br/>
          <span class="texto-soft">${escapeHtml(t.originStoreName)} → ${escapeHtml(t.destStoreName)}</span>
        </div>
        <span class="badge ${statusBadge[t.status]||'badge-muted'}">${escapeHtml(t.status)}</span>
      </div>
    </div>`).join('');
}

/* =========================================================================
   EDITAR / EXCLUIR
   ========================================================================= */
function abrirEditar(deviceId){
  const d = buscarDevice(deviceId);
  if (!d) return;
  editarDeviceId = deviceId;
  document.getElementById('editarNome').value = d.nome||'';
  document.getElementById('editarImei').value = d.imei||'';
  aplicarValorSelect('editarArmazenamento', d.armazenamento);
  aplicarValorSelect('editarRam', d.ram);
  document.getElementById('editarNfc').value = d.nfc||'';
  document.getElementById('editarGarantia').value = d.garantia||'';
  document.getElementById('editarCategoria').value = d.categoria||'NOVO';
  document.getElementById('editarAvista').value = d.avista||'';
  document.getElementById('editarCinco').value = d.cinco||'';
  document.getElementById('editarDez').value = d.dez||'';
  document.getElementById('editarDezoito').value = d.dezoito||'';
  document.getElementById('editarObservacao').value = d.observacao||'';
  abrirPainel('boxEditar');
}

async function salvarEdicao(){
  const dados = {
    nome: valor('editarNome'), imei: valor('editarImei'),
    armazenamento: valorSelectOuManual('editarArmazenamento'), ram: valorSelectOuManual('editarRam'),
    nfc: valor('editarNfc'), garantia: valor('editarGarantia'), categoria: valor('editarCategoria'),
    avista: valor('editarAvista'), cinco: valor('editarCinco'), dez: valor('editarDez'), dezoito: valor('editarDezoito'),
    observacao: valor('editarObservacao'), updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  try{
    const original = buscarDevice(editarDeviceId);
    await db.collection('devices').doc(editarDeviceId).update(dados);
    await registrarHistorico([original?.storeId].filter(Boolean), 'Edição', dados, `Dados do aparelho "${dados.nome}" atualizados.`);
    fecharPainel();
    showToast('Aparelho atualizado!','success');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

async function excluirAparelho(deviceId){
  if (!confirm('Deseja excluir este aparelho da lista?')) return;
  const d = buscarDevice(deviceId);
  if (!d) return;
  try{
    await db.collection('devices').doc(deviceId).delete();
    await registrarHistorico([d.storeId], 'Exclusão', d, `Aparelho "${d.nome}" removido da lista.`);
    showToast('Aparelho excluído.','info');
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

function copiarInfoAparelho(deviceId){
  const d = buscarDevice(deviceId);
  if (!d) return;
  const texto = [
    `Produto: ${d.nome||'—'}`,
    `Qualidade: ${d.categoria||'—'}`,
    `Armazenamento: ${d.armazenamento||'—'}`,
    `Memoria Ram: ${d.ram||'—'}`,
    `Garantia: ${d.garantia||'—'}`,
    `Avista: ${d.avista||'—'}`,
    `5x: ${d.cinco||'—'}`,
    `10x: ${d.dez||'—'}`,
    `18x: ${d.dezoito||'—'}`
  ].join('\n');
  navigator.clipboard.writeText(texto)
    .then(()=>showToast('Informações copiadas!','success'))
    .catch(err=>showToast('Erro ao copiar: '+err.message,'error'));
}

/* =========================================================================
   ABA HISTÓRICO
   ========================================================================= */
async function gerarHistorico(){
  try{
    let query;
    if (isMasterUser){
      const lojaFiltro = valor('selectLojaHistorico');
      query = lojaFiltro
        ? db.collection('history').where('visibleTo','array-contains', lojaFiltro).orderBy('createdAt','desc').limit(500)
        : db.collection('history').orderBy('createdAt','desc').limit(500);
    } else {
      if (!myStoreId){ historicoCache=[]; renderHistorico(); return; }
      query = db.collection('history').where('visibleTo','array-contains', myStoreId).orderBy('createdAt','desc').limit(500);
    }
    const snap = await query.get();
    historicoCache = [];
    snap.forEach(doc=>historicoCache.push({id:doc.id, ...doc.data()}));
    renderHistorico();
  }catch(err){ showToast('Erro ao carregar histórico: '+err.message,'error'); }
}

function renderHistorico(){
  const inicio = valor('histInicio'), fim = valor('histFim'), tipo = valor('histTipo');
  const busca = valor('histBusca').toLowerCase();
  const box = document.getElementById('relatorioHistorico');

  const filtrado = historicoCache.filter(h=>{
    if (!h.createdAt) return true;
    const dataItem = h.createdAt.toDate ? formatarDataSP(h.createdAt.toDate()) : '';
    const okData = (!inicio || dataItem >= inicio) && (!fim || dataItem <= fim);
    const okTipo = tipo==='Todos' || h.tipo===tipo;
    const okBusca = !busca || [h.device?.nome, h.device?.imei, h.detalhe, h.extra?.cliente].filter(Boolean).some(v=>String(v).toLowerCase().includes(busca));
    return okData && okTipo && okBusca;
  });

  if (filtrado.length===0){
    box.className = 'relatorio-box empty-state';
    box.innerHTML = '<i class="fa-solid fa-inbox"></i>Nenhum histórico encontrado.';
    return;
  }
  box.className = 'relatorio-box';
  box.textContent = filtrado.map(h=>{
    const dataBR = h.createdAt?.toDate ? formatarDataHoraSP(h.createdAt.toDate()) : '—';
    return `[${dataBR}] ${h.tipo}\nAparelho: ${h.device?.nome||''} | IMEI: ${h.device?.imei||''}\nDetalhe: ${h.detalhe||''}\nUsuário: ${h.userEmail||''}\n`;
  }).join('\n------------------------------\n');
}

function copiarRelatorio(){
  const t = document.getElementById('relatorioHistorico').textContent;
  if (!t || t.includes('Nenhum histórico') || t.includes('Clique em')){ showToast('Nada para copiar.','warning'); return; }
  navigator.clipboard.writeText(t).then(()=>showToast('Relatório copiado!','success'));
}

async function apagarHistoricoFiltrado(){
  if (!isMasterUser) return;
  if (historicoCache.length===0){ showToast('Nada para apagar. Filtre o histórico primeiro.','warning'); return; }
  if (!confirm(`Apagar os ${historicoCache.length} registros de histórico atualmente listados? Essa ação não pode ser desfeita.`)) return;
  try{
    let items = [...historicoCache];
    while (items.length){
      const chunk = items.splice(0,400);
      const batch = db.batch();
      chunk.forEach(h=>batch.delete(db.collection('history').doc(h.id)));
      await batch.commit();
    }
    showToast('Histórico apagado.','info');
    gerarHistorico();
  }catch(err){ showToast('Erro: '+err.message,'error'); }
}

/* =========================================================================
   ADMINISTRAÇÃO (MASTER)
   ========================================================================= */
function renderTabelaLojasAdmin(){
  const tbody = document.getElementById('corpoTabelaLojasAdmin');
  if (!tbody) return;
  const lojas = Object.values(lojasMap).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if (lojas.length===0){ tbody.innerHTML = '<tr><td colspan="3" class="empty">Nenhuma loja.</td></tr>'; return; }
  tbody.innerHTML = lojas.map(l=>`
    <tr>
      <td><strong>${escapeHtml(l.name)}</strong></td>
      <td>${l.active!==false ? '<span class="badge badge-success">Ativa</span>' : '<span class="badge badge-muted">Inativa</span>'}</td>
      <td>
        <button class="btn-ghost btn-icon" onclick="renomearLoja('${l.id}')" title="Renomear"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-ghost btn-icon" onclick="alternarAtivaLoja('${l.id}')" title="Ativar/Desativar"><i class="fa-solid fa-power-off"></i></button>
        <button class="btn-danger btn-icon" onclick="excluirLoja('${l.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

async function renomearLoja(storeId){
  const novoNome = prompt('Novo nome da loja:', lojasMap[storeId]?.name||'');
  if (novoNome===null || !novoNome.trim()) return;
  try{ await db.collection('stores').doc(storeId).update({ name: novoNome.trim() }); showToast('Loja atualizada.','success'); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
async function abrirEdicaoNomeLoja(){
  if (!myStoreId){ showToast('Você não está associado a nenhuma loja.','warning'); return; }
  await renomearLoja(myStoreId);
}
async function alternarAtivaLoja(storeId){
  const atual = lojasMap[storeId]?.active !== false;
  try{ await db.collection('stores').doc(storeId).update({ active: !atual }); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
async function excluirLoja(storeId){
  if (!confirm('Excluir esta loja? Os aparelhos já cadastrados nela permanecerão no banco de dados, mas a loja deixará de aparecer nas listas de seleção. Use com cuidado.')) return;
  try{ await db.collection('stores').doc(storeId).delete(); showToast('Loja excluída.','info'); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}

function renderTabelaUsuariosAdmin(){
  const tbody = document.getElementById('corpoTabelaUsuariosAdmin');
  if (!tbody) return;
  if (usuariosCache.length===0){ tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum usuário.</td></tr>'; return; }
  const lojasOpts = Object.values(lojasMap).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  tbody.innerHTML = usuariosCache.map(u=>`
    <tr>
      <td>${escapeHtml(u.email)}</td>
      <td>
        <select onchange="mudarPapelUsuario('${u.id}', this.value)" style="width:auto;">
          <option value="padrao" ${u.role==='padrao'?'selected':''}>Padrão</option>
          <option value="master" ${u.role==='master'?'selected':''}>Master</option>
        </select>
      </td>
      <td>
        <select onchange="mudarLojaUsuario('${u.id}', this.value)" style="width:auto;">
          <option value="">— Sem loja —</option>
          ${lojasOpts.map(l=>`<option value="${l.id}" ${u.storeId===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </td>
      <td>${u.active!==false ? '<span class="badge badge-success">Ativo</span>' : '<span class="badge badge-muted">Desativado</span>'}</td>
      <td>
        <button class="btn-ghost btn-icon" onclick="alternarAtivoUsuario('${u.id}')" title="Ativar/Desativar"><i class="fa-solid fa-power-off"></i></button>
        <button class="btn-danger btn-icon" onclick="excluirPerfilUsuario('${u.id}')" title="Remover perfil"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

async function mudarPapelUsuario(uid, novoPapel){
  try{ await db.collection('users').doc(uid).update({ role: novoPapel }); showToast('Papel atualizado.','success'); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
async function mudarLojaUsuario(uid, novaLojaId){
  try{ await db.collection('users').doc(uid).update({ storeId: novaLojaId || null }); showToast('Loja do usuário atualizada.','success'); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
async function alternarAtivoUsuario(uid){
  const u = usuariosCache.find(x=>x.id===uid);
  if (!u) return;
  try{ await db.collection('users').doc(uid).update({ active: !(u.active !== false) }); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
async function excluirPerfilUsuario(uid){
  if (!confirm('Remover o perfil deste usuário do sistema?\n\nATENÇÃO: a conta de login (Firebase Authentication) não é removida automaticamente — isso deve ser feito no Console do Firebase ou pelo próprio usuário. Esta ação apenas remove o acesso dele ao sistema.')) return;
  try{ await db.collection('users').doc(uid).delete(); showToast('Perfil removido.','info'); }
  catch(err){ showToast('Erro: '+err.message,'error'); }
}
