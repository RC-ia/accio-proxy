#!/usr/bin/env node
// src/cli.js
// Interactive menu for Accio Proxy (pt-BR).

const readline = require('readline');
const accounts = require('./accounts');
const browser = require('./browser');
const { startServer } = require('./server');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function printMenu() {
  const active = accounts.getActiveName();
  console.log('');
  console.log('══════════════════════════════════');
  console.log('         Accio Proxy');
  console.log('══════════════════════════════════');
  console.log(`  Conta ativa: ${active || '(nenhuma)'}`);
  console.log('──────────────────────────────────');
  console.log('  1) Entrar na conta (login no Chrome)');
  console.log('  2) Trocar conta ativa');
  console.log('  3) Listar contas');
  console.log('  4) Remover conta');
  console.log('  5) Iniciar servidor API');
  console.log('  6) Sair');
  console.log('══════════════════════════════════');
}

async function optionLogin() {
  const name = (await question('Nome da conta (ex: pessoal): ')).trim();
  if (!name) {
    console.log('❌ Nome inválido.');
    return;
  }

  let account = accounts.find(name);
  if (!account) {
    console.log(`➕ Criando conta "${name}"…`);
    account = accounts.add(name);
  } else {
    accounts.setActive(name);
  }

  console.log('');
  console.log(`🌐 Abrindo Chrome para a conta "${name}"…`);
  console.log('   Faça o login no Accio no navegador que abrir.');
  console.log('   Quando terminar o login, volte aqui e pressione Enter.');
  console.log('');

  try {
    await browser.openForLogin(name);
  } catch (err) {
    console.error(`❌ Erro ao abrir Chrome: ${err.message}`);
    return;
  }

  await question('Pressione Enter quando o login estiver concluído…');
  console.log('✅ Perfil salvo. A sessão permanece no profile do Chrome.');
  console.log(`   Profile Windows: ${account.win_data_dir}`);
}

async function optionSwitch() {
  const list = accounts.list();
  if (list.length === 0) {
    console.log('⚠️  Nenhuma conta cadastrada. Use a opção 1 primeiro.');
    return;
  }
  console.log('\nContas disponíveis:');
  list.forEach((a, i) => {
    const mark = a.name === accounts.getActiveName() ? ' (ativa)' : '';
    console.log(`  ${i + 1}) ${a.name}${mark}`);
  });
  const raw = (await question('Número ou nome da conta: ')).trim();
  if (!raw) return;

  let name = raw;
  const num = Number(raw);
  if (!Number.isNaN(num) && num >= 1 && num <= list.length) {
    name = list[num - 1].name;
  }

  if (accounts.setActive(name)) {
    await browser.closeBrowser();
    console.log(`✅ Conta ativa: ${name}`);
  } else {
    console.log(`❌ Conta "${name}" não encontrada.`);
  }
}

async function optionList() {
  const list = accounts.list();
  if (list.length === 0) {
    console.log('⚠️  Nenhuma conta cadastrada.');
    return;
  }
  const active = accounts.getActiveName();
  console.log('\nContas:');
  for (const a of list) {
    const mark = a.name === active ? '★' : ' ';
    console.log(
      `  ${mark} ${a.name}  | criada: ${a.created_at || '-'}  | último uso: ${a.last_used || '-'}`,
    );
  }
}

async function optionRemove() {
  const list = accounts.list();
  if (list.length === 0) {
    console.log('⚠️  Nenhuma conta cadastrada.');
    return;
  }
  list.forEach((a, i) => console.log(`  ${i + 1}) ${a.name}`));
  const raw = (await question('Nome da conta a remover: ')).trim();
  if (!raw) return;

  const confirm = (
    await question(`Tem certeza que deseja remover "${raw}"? (s/N): `)
  )
    .trim()
    .toLowerCase();
  if (confirm !== 's' && confirm !== 'sim') {
    console.log('Cancelado.');
    return;
  }

  if (accounts.remove(raw)) {
    await browser.closeBrowser();
    console.log(`✅ Conta "${raw}" removida (profile em disco NÃO foi apagado).`);
  } else {
    console.log(`❌ Conta "${raw}" não encontrada.`);
  }
}

async function optionServer() {
  if (!accounts.getActiveName()) {
    console.log(
      '⚠️  Nenhuma conta ativa. Recomenda-se usar a opção 1 antes de iniciar o servidor.',
    );
    const cont = (await question('Iniciar mesmo assim? (s/N): ')).trim().toLowerCase();
    if (cont !== 's' && cont !== 'sim') return;
  }

  const portRaw = (await question('Porta [3000]: ')).trim();
  const port = portRaw ? Number(portRaw) : 3000;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.log('❌ Porta inválida.');
    return;
  }

  console.log('');
  console.log('Iniciando servidor… (Ctrl+C para parar e voltar ao menu)');
  try {
    await startServer(port);
    // Keep process alive; wait until SIGINT
    await new Promise((resolve) => {
      const onSig = () => {
        process.off('SIGINT', onSig);
        console.log('\n⏹  Servidor parado.');
        resolve();
      };
      process.on('SIGINT', onSig);
    });
  } catch (err) {
    console.error(`❌ Erro ao iniciar servidor: ${err.message}`);
  }
}

async function mainLoop() {
  // Ensure accounts.json exists
  accounts.load();

  let running = true;
  while (running) {
    printMenu();
    const choice = (await question('Escolha: ')).trim();

    switch (choice) {
      case '1':
        await optionLogin();
        break;
      case '2':
        await optionSwitch();
        break;
      case '3':
        await optionList();
        break;
      case '4':
        await optionRemove();
        break;
      case '5':
        await optionServer();
        break;
      case '6':
      case 'q':
      case 'quit':
      case 'sair':
        running = false;
        break;
      default:
        console.log('Opção inválida.');
    }
  }

  console.log('Até logo!');
  try {
    await browser.closeBrowser();
  } catch (_) {
    /* ignore */
  }
  rl.close();
  process.exit(0);
}

// Handle Ctrl+C at menu level
process.on('SIGINT', async () => {
  console.log('\nSaindo…');
  try {
    await browser.closeBrowser();
  } catch (_) {
    /* ignore */
  }
  rl.close();
  process.exit(0);
});

if (require.main === module) {
  mainLoop().catch((err) => {
    console.error('[cli] fatal:', err);
    process.exit(1);
  });
}

module.exports = { mainLoop };
