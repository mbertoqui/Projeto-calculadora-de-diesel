// validationUtils.js
// Este arquivo permanece em JavaScript puro, pois contém apenas lógica de validação.

/**
 * validationUtils.js
 * Contém funções utilitárias para validação de formulários.
 */

/**
 * Valida um campo individual e exibe/remove a mensagem de erro.
 * @param {HTMLElement} input - O elemento input, select ou textarea a ser validado.
 * @returns {boolean} True se o campo é válido, false caso contrário.
 */
export function validateField(input) {
    let isValid = true;

    // Remove mensagem de erro existente para reavaliação
    const existingError = input.parentNode.querySelector('.error-message');
    if (existingError) {
        existingError.remove();
    }
    input.classList.remove('border-red-500'); // Remove classe de erro visual

    if (input.hasAttribute('required') && !input.value.trim()) {
        isValid = false;
    } else if (input.type === 'number') {
        const value = parseFloat(input.value);
        if (isNaN(value) && input.hasAttribute('required')) {
            isValid = false;
        } else if (input.min && value < parseFloat(input.min)) {
            isValid = false;
        } else if (input.max && value > parseFloat(input.max)) {
            isValid = false;
        }
    } else if (input.tagName === 'SELECT' && input.value === '') {
        isValid = false;
    }

    // Validação específica para o grupo de rádio 'atingiuMedia'
    if (input.name === 'atingiuMedia') {
        const radioGroupContainer = input.closest('.highlighted-radio-group-container');
        if (radioGroupContainer) {
            const anyChecked = Array.from(document.querySelectorAll(`input[name="${input.name}"]`)).some(radio => radio.checked);
            if (!anyChecked) {
                isValid = false;
            }

            if (!isValid) {
                radioGroupContainer.classList.add('border-red-500'); // Adiciona borda de erro ao container
                let errorDisplay = radioGroupContainer.querySelector('.error-message');
                if (!errorDisplay) {
                    errorDisplay = document.createElement('div');
                    errorDisplay.className = 'text-red-500 text-sm mt-1 error-message';
                    radioGroupContainer.appendChild(errorDisplay);
                }
                errorDisplay.textContent = 'Selecione uma opção.';
            } else {
                radioGroupContainer.classList.remove('border-red-500');
                const errorDisplay = radioGroupContainer.querySelector('.error-message');
                if (errorDisplay) errorDisplay.remove();
            }
            return isValid; // Retorna cedo para radios, pois o erro é no grupo
        }
    }

    if (!isValid) {
        input.classList.add('border-red-500'); // Adiciona classe de erro visual
    } else {
        input.classList.remove('border-red-500');
    }

    return isValid;
}

/**
 * Valida todos os campos obrigatórios de um formulário.
 * Adiciona/remove classes 'invalid' e mensagens de erro.
 * @param {HTMLFormElement} formElement - O formulário a ser validado.
 * @returns {boolean} True se todos os campos obrigatórios são válidos, false caso contrário.
 */
export function validateForm(formElement) {
    let isValid = true;
    const requiredInputs = formElement.querySelectorAll('[required]');

    // Limpa todos os erros existentes antes de revalidar
    formElement.querySelectorAll('.error-message').forEach(el => el.remove());
    formElement.querySelectorAll('.border-red-500').forEach(el => el.classList.remove('border-red-500'));

    requiredInputs.forEach(input => {
        if (!validateField(input)) {
            isValid = false;
        }
    });

    // Validação específica para o grupo de rádio 'atingiuMedia'
    const atingiuMediaRadios = formElement.querySelectorAll('input[name="atingiuMedia"]');
    if (atingiuMediaRadios.length > 0) {
        const isRadioChecked = Array.from(atingiuMediaRadios).some(radio => radio.checked);
        const radioGroupContainer = atingiuMediaRadios[0].closest('.highlighted-radio-group-container');

        if (!isRadioChecked) {
            isValid = false;
            if (radioGroupContainer) {
                radioGroupContainer.classList.add('border-red-500');
                let errorMessage = radioGroupContainer.querySelector('.error-message');
                if (!errorMessage) {
                    errorMessage = document.createElement('div');
                    errorMessage.className = 'text-red-500 text-sm mt-1 error-message';
                    radioGroupContainer.appendChild(errorMessage);
                }
                errorMessage.textContent = 'Selecione uma opção.';
            }
        } else {
            if (radioGroupContainer) {
                radioGroupContainer.classList.remove('border-red-500');
                const errorMessage = radioGroupContainer.querySelector('.error-message');
                if (errorMessage) {
                    errorMessage.remove();
                }
            }
        }
    }

    return isValid;
}
