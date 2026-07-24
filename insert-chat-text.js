(function(text) {
  const editor = document.querySelector('.chat-input-scrollable');
  if (!editor) return console.error('Editor não encontrado');

  // Foca no elemento
  editor.focus();

  // Tenta encontrar o parágrafo interno ou usa o próprio editor
  const target = editor.querySelector('p') || editor;

  // Limpa o conteúdo atual e insere o novo texto
  target.textContent = text;

  // Dispara eventos para que o site perceba a mudança (importante para habilitar o botão de enviar)
  const inputEvent = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text
  });
  editor.dispatchEvent(inputEvent);

  // Move o cursor para o final do texto
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(target);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);

  console.log('Texto inserido com sucesso!');
})('Olá, isso é um teste!');
