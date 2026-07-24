(function() {
  const sendButton = document.querySelector('button.bg-primary.text-primary-foreground.cursor-pointer');

  if (sendButton) {
    if (!sendButton.disabled) {
      sendButton.click();
      console.log('Botão clicado!');
    } else {
      console.warn('O botão está desativado (disabled). Verifique se há texto no campo.');
    }
  } else {
    console.error('Botão não encontrado.');
  }
})();
