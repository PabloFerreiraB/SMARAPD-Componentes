﻿/*
 * angucomplete-alt
 * Autocomplete directive for AngularJS
 * This is a fork of Daryl Rowland's angucomplete with some extra features.
 * By Hidenari Nozaki
 */

/*! Copyright (c) 2014 Hidenari Nozaki and contributors | Licensed under the MIT license */

'use strict';

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        // CommonJS
        module.exports = factory(require('angular'));
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(['angular'], factory);
    } else {
        // Global Variables
        factory(root.angular);
    }
}(window, function (angular) {

    angular.module('suggestion', [])
        .directive('angucompleteAlt', ['$q', '$parse', '$http', '$sce', '$timeout', '$templateCache', function ($q, $parse, $http, $sce, $timeout, $templateCache) {
            // keyboard events
            var KEY_DW = 40;
            var KEY_RT = 39;
            var KEY_UP = 38;
            var KEY_LF = 37;
            var KEY_ES = 27;
            var KEY_EN = 13;
            var KEY_BS = 8;
            var KEY_DEL = 46;
            var KEY_TAB = 9;

            var MIN_LENGTH = 3;
            var MAX_LENGTH = 524288; // o comprimento máximo padrão pelo atributo html maxlength
            var PAUSE = 500;
            var BLUR_TIMEOUT = 200;

            // string constants
            var REQUIRED_CLASS = 'autocomplete-required';
            var TEXT_SEARCHING = 'Procurando...';
            var TEXT_NORESULTS = 'Nenhum resultado encontrado';

            return {
                restrict: 'EA',
                require: '^?form',
                scope: {
                    selectedObject: '=?',
                    disableInput: '=',
                    initialValue: '=?',
                    localData: '@',
                    remoteUrlRequestFormatter: '=',
                    remoteUrlRequestWithCredentials: '@',
                    remoteUrlResponseFormatter: '=',
                    remoteUrlErrorCallback: '=',
                    remoteApiHandler: '=',
                    id: '@',
                    type: '@',
                    placeholder: '@',
                    remoteUrl: '@',
                    remoteUrlDataField: '@',
                    titleField: '@',
                    descriptionField: '@',
                    imageField: '@',
                    inputClass: '@',
                    pause: '@',
                    searchFields: '@',
                    minlength: '@',
                    matchClass: '@',
                    clearSelected: '@',
                    overrideSuggestions: '@',
                    fieldRequired: '@',
                    fieldRequiredClass: '@',
                    inputChanged: '=',
                    autoMatch: '@',
                    focusOut: '&',
                    focusIn: '&',
                    inputName: '@',
                    searchStr: '=?',
                    config: '=?'
                },

                templateUrl: 'templates/directives/suggestion.html',
                link: function (scope, elem, attrs, ctrl) {
                    var inputField = elem.find('input');
                    var minlength = MIN_LENGTH;
                    var searchTimer = null;
                    var hideTimer;
                    var requiredClassName = REQUIRED_CLASS;
                    var responseFormatter;
                    var validState = null;
                    var httpCanceller = null;
                    var dd = elem[0].querySelector('.angucomplete-dropdown');
                    var isScrollOn = false;
                    var mousedownOn = null;
                    var unbindInitialValue;

                    elem.on('mousedown', function (event) {
                        mousedownOn = event.target.id;
                    });


                    scope.countIndexResult = 0;
                    scope.currentIndex = null;
                    scope.searching = false;
                    scope.searchStr = scope.initialValue;
                    unbindInitialValue = scope.$watch('initialValue', function (newval, oldval) {
                        if (newval && newval.length > 0) {
                            scope.searchStr = scope.initialValue;
                            handleRequired(true);
                            unbindInitialValue();
                        }
                    });

                    function consumingData() {
                        scope.localData = scope.config.data.map(function (item) {
                            return {
                                data: item
                            };
                        });
                    }


                    scope.$on('angucomplete-alt:clearInput', function (event, elementId) {
                        if (!elementId) {
                            scope.searchStr = null;
                            clearResults();
                        } else { // id is given
                            if (scope.id === elementId) {
                                scope.searchStr = null;
                                clearResults();
                            }
                        }
                    });

                    // for IE8 quirkiness about event.which
                    function ie8EventNormalizer(event) {
                        return event.which ? event.which : event.keyCode;
                    }

                    function callOrAssign(value) {
                        if (typeof scope.config.selectedObject === 'function') {
                            scope.config.selectedObject(value.originalObject.data);
                            scope.searchStr = value.description.data[scope.config.fieldValue];

                        } else {
                            scope.selectedObject = value;
                        }

                        if (value) {
                            handleRequired(true);
                        } else {
                            handleRequired(false);
                        }
                    }

                    function callFunctionOrIdentity(fn) {
                        return function (data) {
                            return scope[fn] ? scope[fn](data) : data;
                        };
                    }

                    function setInputString(str) {
                        callOrAssign({
                            originalObject: str
                        });

                        if (scope.clearSelected) {
                            scope.searchStr = null;
                        }
                        clearResults();
                    }

                    function extractTitle(data) {
                        // split title fields and run extractValue for each and join with ' '
                        return scope.titleField.split(',')
                            .map(function (field) {
                                return extractValue(data, field);
                            })
                            .join(' ');
                    }

                    function extractValue(obj, key) {
                        var keys, result;
                        if (key) {
                            keys = key.split('.');
                            result = obj;
                            keys.forEach(function (k) {
                                result = result[k];
                            });
                        } else {
                            result = obj;
                        }
                        return result;
                    }

                    function findMatchString(target, str) {
                        var result, matches, re;
                        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
                        // Escape user input to be treated as a literal string within a regular expression
                        re = new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                        if (!target) {
                            return;
                        }
                        matches = target.match(re);
                        if (matches) {
                            result = target.replace(re,
                                '<span class="' + scope.matchClass + '">' + matches[0] + '</span>');
                        } else {
                            result = target;
                        }
                        return $sce.trustAsHtml(result);
                    }

                    function handleRequired(valid) {
                        scope.notEmpty = valid;
                        validState = scope.searchStr;
                        if (scope.fieldRequired && ctrl) {
                            ctrl.$setValidity(requiredClassName, valid);
                        }
                    }

                    function keyupHandler(event) {

                        consumingData();

                        var which = ie8EventNormalizer(event);
                        if (which === KEY_LF || which === KEY_RT) {
                            // do nothing
                            return;
                        }

                        //evento de enter
                        if (which === KEY_EN) {
                            //event.preventDefault();
                            scope.searchStr = scope.results[scope.countIndexResult - 1].originalObject.data[scope.config.fieldValue];

                            if (!scope.config.isObject) {
                                scope.$apply(function () {
                                    inputField.val(scope.searchStr);
                                    let result = []
                                    result.classe = scope.searchStr;
                                    scope.config.selectedObject(result);
                                });
                                scope.showDropdown = false;
                            }else{
                                inputField.val(scope.searchStr);
                                let result = undefined
                                //result.classe = scope.searchStr;
                                result = scope.results[scope.countIndexResult - 1].originalObject.data
                                scope.config.selectedObject(result);
                            }
                            clearResults();
                            //scope.config.selectedObject(value.originalObject.data);


                        } else if (which === KEY_DW) {
                            event.preventDefault();
                            // if (!scope.showDropdown && scope.searchStr && scope.searchStr.length >= minlength) {
                            //     initResults();
                            //     scope.searching = true;
                            //     searchTimerComplete(scope.searchStr);
                            // }
                            if ((scope.results.length != 0 || scope.results) && scope.countIndexResult < scope.results.length) {
                                scope.searchStr = scope.results[scope.countIndexResult].originalObject.data[scope.config.fieldValue];
                                scope.countIndexResult++;
                                scope.$apply(function () {
                                    inputField.val(scope.searchStr);
                                });
                            }
                        } else if (which === KEY_UP) {
                            event.preventDefault();
                            // if (!scope.showDropdown && scope.searchStr && scope.searchStr.length >= minlength) {
                            //     initResults();
                            //     scope.searching = true;
                            //     searchTimerComplete(scope.searchStr);
                            // }
                            if (scope.results.length != 0 && (scope.countIndexResult <= scope.results.length && scope.countIndexResult != 0)) {
                                scope.countIndexResult--;
                                scope.searchStr = scope.results[scope.countIndexResult - 1].originalObject.data[scope.config.fieldValue];
                                scope.$apply(function () {
                                    inputField.val(scope.searchStr);
                                });
                            }
                        } else if (which === KEY_BS) {
                            scope.config.objeto.icone = undefined


                        }

                        // if(which === KEY_DW){
                        //     scope.searchStr = scope.results[scope.countIndexResult].originalObject.data.classe;
                        //     scope.countIndexResult++;
                        // }
                        else if (which === KEY_ES) {
                            clearResults();
                            scope.$apply(function () {
                                inputField.val(scope.searchStr);
                            });
                        } else {

                            scope.countIndexResult = 0;

                            if (minlength === 0 && !scope.searchStr) {
                                return;
                            }

                            if (!scope.searchStr || scope.searchStr === '') {
                                scope.showDropdown = false;
                            } else if (scope.searchStr.length >= minlength) {
                                initResults();

                                if (searchTimer) {
                                    $timeout.cancel(searchTimer);
                                }

                                scope.searching = true;

                                searchTimer = $timeout(function () {
                                    searchTimerComplete(scope.searchStr);
                                }, scope.pause);
                            }

                            if (validState && validState !== scope.searchStr && !scope.clearSelected) {
                                callOrAssign(undefined);
                            }
                        }
                    }

                    function handleOverrideSuggestions(event) {
                        if (scope.overrideSuggestions &&
                            !(scope.selectedObject && scope.selectedObject.originalObject === scope.searchStr)) {
                            if (event) {
                                event.preventDefault();
                            }
                            setInputString(scope.searchStr);
                        }
                    }

                    function dropdownRowOffsetHeight(row) {
                        var css = getComputedStyle(row);
                        return row.offsetHeight +
                            parseInt(css.marginTop, 10) + parseInt(css.marginBottom, 10);
                    }

                    function dropdownHeight() {
                        return dd.getBoundingClientRect().top +
                            parseInt(getComputedStyle(dd).maxHeight, 10);
                    }

                    function dropdownRow() {
                        return elem[0].querySelectorAll('.angucomplete-row')[scope.currentIndex];
                    }

                    function dropdownRowTop() {
                        return dropdownRow().getBoundingClientRect().top -
                            (dd.getBoundingClientRect().top +
                                parseInt(getComputedStyle(dd).paddingTop, 10));
                    }

                    function dropdownScrollTopTo(offset) {
                        dd.scrollTop = dd.scrollTop + offset;
                    }

                    function updateInputField() {
                        var current = scope.results[scope.currentIndex];
                        if (scope.matchClass) {
                            inputField.val(extractTitle(current.originalObject));
                        } else {
                            inputField.val(current.title);
                        }
                    }

                    function keydownHandler(event) {
                        var which = ie8EventNormalizer(event);
                        var row = null;
                        var rowTop = null;

                        if (which === KEY_EN && scope.results) {
                            if (scope.currentIndex >= 0 && scope.currentIndex < scope.results.length) {
                                event.preventDefault();
                                scope.selectResult(scope.results[scope.currentIndex]);

                            } else {
                                handleOverrideSuggestions(event);
                                clearResults();
                            }
                            scope.$apply();
                        } else if (which === KEY_DW && scope.results) {
                            event.preventDefault();
                            if ((scope.currentIndex + 1) < scope.results.length && scope.showDropdown) {
                                scope.$apply(function () {
                                    scope.currentIndex++;
                                    updateInputField();
                                });

                                if (isScrollOn) {
                                    row = dropdownRow();
                                    if (dropdownHeight() < row.getBoundingClientRect().bottom) {
                                        dropdownScrollTopTo(dropdownRowOffsetHeight(row));
                                    }
                                }
                            }
                        } else if (which === KEY_UP && scope.results) {
                            event.preventDefault();
                            if (scope.currentIndex >= 1) {
                                scope.$apply(function () {
                                    scope.currentIndex--;
                                    updateInputField();
                                });

                                if (isScrollOn) {
                                    rowTop = dropdownRowTop();
                                    if (rowTop < 0) {
                                        dropdownScrollTopTo(rowTop - 1);
                                    }
                                }
                            } else if (scope.currentIndex === 0) {
                                scope.$apply(function () {
                                    scope.currentIndex = -1;
                                    inputField.val(scope.searchStr);
                                });
                            }
                        } else if (which === KEY_TAB) {
                            if (scope.results && scope.results.length > 0 && scope.showDropdown) {
                                if (scope.currentIndex === -1 && scope.overrideSuggestions) {
                                    // intentionally not sending event so that it does not
                                    // prevent default tab behavior
                                    handleOverrideSuggestions();
                                } else {
                                    if (scope.currentIndex === -1) {
                                        scope.currentIndex = 0;
                                    }
                                    scope.selectResult(scope.results[scope.currentIndex]);
                                    scope.$digest();
                                }
                            } else {
                                // no results
                                // intentionally not sending event so that it does not
                                // prevent default tab behavior
                                if (scope.searchStr && scope.searchStr.length > 0) {
                                    handleOverrideSuggestions();
                                }
                            }
                        }
                    }

                    function httpSuccessCallbackGen(str) {
                        return function (responseData, status, headers, config) {
                            // normalize return obejct from promise
                            if (!status && !headers && !config) {
                                responseData = responseData.data;
                            }
                            scope.searching = false;
                            processResults(
                                extractValue(responseFormatter(responseData), scope.remoteUrlDataField),
                                str);
                        };
                    }

                    function httpErrorCallback(errorRes, status, headers, config) {
                        // normalize return obejct from promise
                        if (!status && !headers && !config) {
                            status = errorRes.status;
                        }
                        if (status !== 0) {
                            if (scope.remoteUrlErrorCallback) {
                                scope.remoteUrlErrorCallback(errorRes, status, headers, config);
                            } else {
                                if (console && console.error) {
                                    console.error('http error');
                                }
                            }
                        }
                    }

                    function cancelHttpRequest() {
                        if (httpCanceller) {
                            httpCanceller.resolve();
                        }
                    }

                    function getRemoteResults(str) {
                        var params = {},
                            url = scope.remoteUrl + encodeURIComponent(str);
                        if (scope.remoteUrlRequestFormatter) {
                            params = {
                                params: scope.remoteUrlRequestFormatter(str)
                            };
                            url = scope.remoteUrl;
                        }
                        if (!!scope.remoteUrlRequestWithCredentials) {
                            params.withCredentials = true;
                        }
                        cancelHttpRequest();
                        httpCanceller = $q.defer();
                        params.timeout = httpCanceller.promise;
                        $http.get(url, params)
                            .success(httpSuccessCallbackGen(str))
                            .error(httpErrorCallback);
                    }

                    function getRemoteResultsWithCustomHandler(str) {
                        cancelHttpRequest();

                        httpCanceller = $q.defer();

                        scope.remoteApiHandler(str, httpCanceller.promise)
                            .then(httpSuccessCallbackGen(str))
                            .catch(httpErrorCallback);
                    }

                    function clearResults() {
                        scope.showDropdown = false;
                        scope.results = [];
                        if (dd) {
                            dd.scrollTop = 0;
                        }
                    }

                    function initResults() {
                        scope.showDropdown = true;
                        scope.currentIndex = -1;
                        scope.results = [];
                    }

                    scope.GetPropertyValue = function (obj, path) {
                        for (var i = 0, path = path.split('.'), len = path.length; i < len; i++) {
                            obj = obj[path[i]];
                        };
                        return obj;
                    }

                    function getLocalResults(str) {
                        var i, match, s, value,
                            searchFields = scope.searchFields.split(','),
                            matches = [];

                        for (i = 0; i < scope.localData.length; i++) {
                            match = false;

                            for (s = 0; s < searchFields.length; s++) {
                                value = extractValue(scope.localData[i].data.data, searchFields[s]) || '';
                                match = match || (value.toLowerCase().indexOf(str.toLowerCase()) >= 0);
                            }

                            if (match) {
                                matches[matches.length] = scope.localData[i].data;
                            }
                        }

                        scope.searching = false;
                        processResults(matches, str);
                    }

                    function checkExactMatch(result, obj, str) {
                        if (!str) {
                            return;
                        }
                        for (var key in obj) {
                            if (obj[key].toLowerCase() === str.toLowerCase()) {
                                scope.selectResult(result);
                                return;
                            }
                        }
                    }

                    function searchTimerComplete(str) {
                        // Begin the search
                        if (!str || str.length < minlength) {
                            return;
                        }
                        if (scope.localData) {
                            scope.$apply(function () {
                                getLocalResults(str);
                            });
                        } else if (scope.remoteApiHandler) {
                            getRemoteResultsWithCustomHandler(str);
                        } else {
                            getRemoteResults(str);
                        }
                    }

                    function processResults(responseData, str) {
                        var i, description, image, text, formattedText, formattedDesc;

                        if (responseData && responseData.length > 0) {
                            scope.results = [];

                            //trata a mensagem do "Exibindo x de y resultados"
                            let totalResponse = responseData.length;
                            let totalExibido = scope.config.quantidadeItens > totalResponse ? totalResponse : scope.config.quantidadeItens;

                            responseData = responseData.slice(0, scope.config.quantidadeItens);

                            let TEXT_RESULTS = textResults(totalExibido, totalResponse);
                            scope.textResults = attrs.textResults ? attrs.textResults : TEXT_RESULTS;


                            for (i = 0; i < responseData.length; i++) {
                                if (scope.titleField && scope.titleField !== '') {
                                    text = formattedText = extractTitle(responseData[i]);
                                }

                                description = '';
                                if (scope.descriptionField) {
                                    description = formattedDesc = extractValue(responseData[i], scope.descriptionField);
                                }

                                image = '';
                                if (scope.imageField) {
                                    image = extractValue(responseData[i], scope.imageField);
                                }

                                if (scope.matchClass) {
                                    formattedText = findMatchString(text, str);
                                    formattedDesc = findMatchString(description, str);
                                }

                                scope.results[scope.results.length] = {
                                    title: formattedText,
                                    description: formattedDesc,
                                    image: image,
                                    originalObject: responseData[i]
                                };

                                if (scope.autoMatch) {
                                    checkExactMatch(scope.results[scope.results.length - 1], {
                                        title: text,
                                        desc: description || ''
                                    }, scope.searchStr);
                                }
                            }

                        } else {
                            scope.results = [];
                        }
                    }

                    function showAll() {
                        if (scope.localData) {
                            processResults(scope.localData, '');
                        } else if (scope.remoteApiHandler) {
                            getRemoteResultsWithCustomHandler('');
                        } else {
                            getRemoteResults('');
                        }
                    }


                    const verifyIfExist = function () {
                        if (!scope.config.objeto.icone) {
                            scope.searchStr = ""
                            scope.config.objeto.icone = undefined;
                        }
                    }

                    function CheckResult(item) {
                        return item == scope.searchStr
                    }

                    scope.onFocusHandler = function () {
                        if (scope.focusIn) {
                            scope.focusIn();
                        }
                        if (minlength === 0 && (!scope.searchStr || scope.searchStr.length === 0)) {
                            scope.showDropdown = true;
                            showAll();
                        }
                    };

                    scope.hideResults = function (event) {
                        if (scope.results && scope.results != 0) {
                            let teste = scope.results.filter(function (item) {
                                return item.originalObject.data.classe === scope.searchStr
                            })[0];

                            if (!teste) {
                                scope.searchStr = undefined;
                                scope.config.objeto.icone = undefined;
                            }
                        }

                        verifyIfExist()
                        if (mousedownOn === scope.id + '_dropdown') {
                            mousedownOn = null;
                        } else {
                            hideTimer = $timeout(function () {
                                clearResults();
                                scope.$apply(function () {
                                    if (scope.searchStr && scope.searchStr.length > 0) {
                                        inputField.val(scope.searchStr);
                                    }
                                });
                            }, BLUR_TIMEOUT);
                            cancelHttpRequest();

                            if (scope.focusOut) {
                                scope.focusOut();
                            }

                            if (scope.overrideSuggestions) {
                                if (scope.searchStr && scope.searchStr.length > 0 && scope.currentIndex === -1) {
                                    handleOverrideSuggestions();
                                }
                            }
                        }

                    };

                    scope.resetHideResults = function () {
                        if (hideTimer) {
                            $timeout.cancel(hideTimer);
                        }
                    };

                    scope.hoverRow = function (index) {
                        scope.currentIndex = index;
                    };

                    scope.selectResult = function (result) {

                        scope.config.teste = true;

                        scope.suggestionForm.suggestionField.$setValidity('required', true);
                        // Restore original values
                        if (scope.matchClass) {
                            result.title = extractTitle(result.originalObject);
                            result.description = extractValue(result.originalObject, scope.descriptionField);
                        }

                        if (scope.clearSelected) {
                            scope.searchStr = null;
                        } else {
                            scope.searchStr = result.title;
                        }
                        callOrAssign(result);
                        clearResults();
                    };

                    scope.inputChangeHandler = function (str) {

                        if(str != undefined){

                        if (str.length < minlength) {
                            clearResults();
                        } else if (str.length === 0 && minlength === 0) {
                            scope.searching = false;
                            showAll();
                        }

                    }

                        if (scope.inputChanged) {
                            str = scope.inputChanged(str);
                        }
                        return str;
                    };

                    // check required
                    if (scope.fieldRequiredClass && scope.fieldRequiredClass !== '') {
                        requiredClassName = scope.fieldRequiredClass;
                    }

                    // check min length
                    if (scope.minlength && scope.minlength !== '') {
                        minlength = parseInt(scope.minlength, 10);
                    }

                    // check pause time
                    if (!scope.pause) {
                        scope.pause = PAUSE;
                    }

                    // check clearSelected
                    if (!scope.clearSelected) {
                        scope.clearSelected = false;
                    }

                    // check override suggestions
                    if (!scope.overrideSuggestions) {
                        scope.overrideSuggestions = false;
                    }

                    // check required field
                    if (scope.fieldRequired && ctrl) {
                        // check initial value, if given, set validitity to true
                        if (scope.initialValue) {
                            handleRequired(true);
                        } else {
                            handleRequired(false);
                        }
                    }

                    scope.type = attrs.type ? attrs.type : 'text';

                    // set strings for "Searching..." and "No results"
                    scope.textSearching = attrs.textSearching ? attrs.textSearching : TEXT_SEARCHING;
                    scope.textNoResults = attrs.textNoResults ? attrs.textNoResults : TEXT_NORESULTS;


                    // set max length (default to maxlength deault from html
                    scope.maxlength = attrs.maxlength ? attrs.maxlength : MAX_LENGTH;

                    // register events
                    inputField.on('keyup', keyupHandler);
                    //inputField.on('keydown', keydownHandler);


                    // set response formatter
                    responseFormatter = callFunctionOrIdentity('remoteUrlResponseFormatter');

                    scope.$on('$destroy', function () {
                        // take care of required validity when it gets destroyed
                        handleRequired(true);
                    });

                    // set isScrollOn
                    $timeout(function () {
                        var css = getComputedStyle(dd);
                        isScrollOn = css.maxHeight && css.overflowY === 'auto';
                    });

                    function textResults(exibido, total) {
                        return `Exibindo ${exibido} de ${total} resultados encontrados.`
                    }
                }
            };
        }]);

}));