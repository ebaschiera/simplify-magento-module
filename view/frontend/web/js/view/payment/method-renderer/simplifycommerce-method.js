define(
  [
      'jquery',
      'underscore',
      'ko',
      'mage/translate',
      'Magento_Payment/js/view/payment/cc-form',
      'Magento_Payment/js/model/credit-card-validation/validator',
      'Magento_Checkout/js/model/payment/additional-validators',
      'Magento_Ui/js/model/messageList',
      'Magento_Checkout/js/model/full-screen-loader',
      'https://www.simplify.com/commerce/simplify.pay.js',
      'Magento_Checkout/js/model/quote',
      'Magento_Checkout/js/action/place-order',
      'Magento_Checkout/js/action/redirect-on-success',
      'Magento_Checkout/js/checkout-data',
      'Magento_Customer/js/model/customer'
  ],
  function (
      $, 
      __, 
      ko,
      $t, 
      Component, 
      validator, 
      additionalValidators, 
      messageList, 
      screenOverlay, 
      sc, 
      quote, 
      placeOrderAction, 
      redirectOnSuccessAction,
      checkoutData,
      customer) 
    {
        'use strict';

        var log = new SimplifyCommerceLog();

        var component = {
            /** UI view template for the payment method */
            defaults: { template: "MasterCard_SimplifyCommerce/payment/simplifycommerce" },
            /** Payment method configuration */
            configuration: {},
            /** Timeout [ms] for payment operations */
            timeout: 5000,
            /** Container where Simplify Commerce hosted form is displayed */
            simplifyContainer: null,
            /** Flag indicating that customer wants to store his credit card */
            isStoreCreditCardChecked: ko.observable(false),
            /** Indicates whether pay button is visible */
            isPayButtonVisible: ko.observable(false),
            /** Saved credit cards of the customer */
            savedCards: {
                items: ko.observableArray([]),
                available: ko.observable(false),
                selectedCard: ko.observable("other"),
                getCardId: function(last4) {
                    return "simplifycommerce-card-" + last4;
                },
                getCardTitle: function(type, last4) {
                    return type.toUpperCase() + " ****-****-****-" + last4;
                },
                cardSelected: function(last4) {
                    if (last4) {
                        // saved card selected, payment will be done server-side
                        component.isPayButtonVisible(true);
                    } else {
                        // saved card not selected, payment will be triggered from Simplify iframe
                        component.isPayButtonVisible(false);
                    }
                    return true;
                }
            },

            /** Initializes the payment method */
            initObservable: function () {
                // Magento 2 bug fix: forgotten subscribe on creditCardType in cc-form.js,
                // effectively card type is not being passed to the server side
                this._super()
                    .observe(["creditCardType"]);

                return this;
            },

            initialize: function () {
                this._super();
                return this;
            },


            /** Unique code of the payment method */
            getCode: function() { 
                return "simplifycommerce";
            },


            /** Indicates that payment method is enabled */
            isActive: function() {
                return true;
            },         


            /** Returns payment method configuration */
            getConfiguration: function() {
                var configuration = null;
                if (window.checkoutConfig && window.checkoutConfig.payment && window.checkoutConfig.payment.simplifycommerce) {
                    configuration = window.checkoutConfig.payment.simplifycommerce;
                    if (configuration) {
                        configuration.isValid = true;
                    }
                }
                configuration = configuration || { isValid: false }; 
                configuration.isCustomerLoggedIn = customer.isLoggedIn();

                if (configuration.canSaveCard && 
                    configuration.isCustomerLoggedIn && 
                    configuration.customer) {
                    __.each(configuration.customer.cards, function(card) { 
                        component.savedCards.items.push(card); 
                        component.savedCards.available(true);
                    });
                }

                if (!configuration.hostedPaymentsEnabled) {
                    component.isPayButtonVisible(true);
                }
               
                log.setDeveloperMode(configuration.isDeveloperMode);
                log.debug("configuration", configuration);
                return configuration;
            },


            /** Triggered when payment form placeholder has been loaded.
             *  Simplify Commerce Hosted Payment form can now initialize.
             */
            onSimplifyContainerRendered: function(sender) {
                component.simplifyContainer = sender;
            },

            onSimplifyFrameRendered: function(sender) {
                if (component.simplifyContainer) {
                    if (!component.handler) {
                        component.handler = new SimplifyCommerceHandler(component.configuration, quote, component.onCardProcessed, component.simplifyContainer);
                    }
                    else {
                        // Rather brutal attempt to patch to the problem of empty IFRAME after single-page navigations 
                        window.location.reload();
                    }
                }
                else {
                    log.error("Hosted Payment Form container not found");
                }
                if (!(component.handler && component.handler.isValid)) {
                    component.showError($t("Simplify Commerce Hosted Payments could not be initialized"));
                    // disable placing orders
                    this.isPlaceOrderActionAllowed(false);
                }
            },


            /** Called by Simplify Hosted Payments on finished payment operation */
            onCardProcessed: function(payment) {
                if (payment && payment.success) {
                    component.showSuccess($t("Credit card validated, authorizing payment ..."));
                    screenOverlay.startLoader();
                    component.submitOrder(payment);
                    // Hide loader overlay after a while - if JS errors happen, 
                    // it might never be hidden, therefore confusing the user.
                    window.setTimeout(function() {
                        screenOverlay.stopLoader();
                        if (component.handler) {
                            component.handler.enablePayButton();
                        }
                    }, component.timeout);
                } 
                else {
                    component.showError($t("The entered credit card could not be processed"));
                }
            },


            /** Sends payment for handling to the server side */
            submitOrder: function(source) {
                var payment = null;
                if (source.placeOrder) { // Payment is triggered by default PLACE ORDER button
                    // Check if payment with one of the saved credit cards
                    payment = { 
                        "cc-use-card": component.savedCards.selectedCard() 
                    };
                    if (!payment["cc-use-card"] || payment["cc-use-card"] === "other")
                        delete payment["cc-use-card"];
                    log.debug("Submitting payment", payment);
                    // If not, use default order processing
                    if (!payment["cc-use-card"]) {
                        this.placeOrder();
                        return;
                    }
                }
                
                // Payment is triggered by hosted payment form or saved credit card is used,
                // therefore handle the payment using custom method
                payment = payment || source || {};
                // Check if card should be stored, ignore if card has already been stored 
                if (payment["cc-last4"] && Boolean(component.isStoreCreditCardChecked())) {
                    if (!__.find(component.savedCards.items, { last4: payment["cc-last4"] })) {
                        payment["cc-save"] = true;
                    }
                }
                if (payment["cc-token"] || payment["cc-use-card"]) {
                    log.debug("Submitting payment", payment);
                    $.when(placeOrderAction({
                        "method": quote.paymentMethod().method,
                        "additional_data": payment
                    }))
                    .done(function () {
                        redirectOnSuccessAction.execute();
                    })
                    .fail(function (error) {
                        screenOverlay.stopLoader();
                        log.error("There was an error while submitting the order", error);
                        component.showError($t("There was an error while submitting the order."));
                    });
                } else {
                    screenOverlay.stopLoader();
                    component.showError($t("Incomplete payment data, cannot submit the order"));
                }
            },


            /** Reports error message to Magento UI */
            showError: function(message) {
                if (message && messageList) {
                    messageList.addErrorMessage({ message: $t(message.toString()) });
                }
            },


            /** Reports success message to Magento UI */
            showSuccess: function(message) {
                if (message && messageList) {
                    messageList.addSuccessMessage({ message: $t(message.toString()) });
                }
            }
        };


        /** Debug log */
        function SimplifyCommerceLog() {
            var log = {
                isDeveloperMode: false,
                
                setDeveloperMode: function(mode) {
                    log.isDeveloperMode = mode;
                },

                info: function(message, data) {
                    if (console) {
                        console.log("SimplifyCommerce: " + (message || ""), data || "");
                    }
                },
                
                debug: function(message, data) {
                    if (console && log.isDeveloperMode) {
                        console.debug("SimplifyCommerce: " + (message || ""), data || "");
                    }
                },
                
                warning: function(message, data) {
                    if (console) {
                        console.warn("SimplifyCommerce: " + (message || ""), data || "");
                    }
                },
                
                error: function(message, data) {
                    if (console) {
                        console.error("SimplifyCommerce: " + (message || ""), data || "");
                    }
                }
            };
            return log;
        };

        
        /** Simplify Commerce payment handler */
        function SimplifyCommerceHandler(configuration, quote, onCardProcessed, container) {
            var log = new SimplifyCommerceLog();
            var handler = {
                /** Indicates that Simplify Commerce Hosted Payments API is available */
                isValid: false,
                /** Payment data */
                payment: null,
                /** Payment operation to execute on validating card.
                  *  As per Simplify Commerce Hosted Payments documentation, 
                  *  accepted values are create.payment and create.token */
                operation: "create.token",
                /** Callback for Simplify Commerce responses */
                onCardProcessed: null,


                /** Initializes Simplify Commerce Hosted Payments form */
                initialize: function(configuration, quote, onCardProcessed) {
                    handler.isValid = false;

                    // check availability of Simplify Commerce payment method
                    if (!configuration) {
                        log.error("Payment method configuration not available!");                    
                        return false;
                    } else {
                        log.setDeveloperMode(configuration.isDeveloperMode);
                    }

                    // check availability of quote data
                    if (!(quote && quote.totals().grand_total > 0)) {
                        log.error("Order not available!");                    
                        return false;
                    }

                    // check availability of Simplify Commerce client-side API
                    if (!window.SimplifyCommerce) {
                        log.error("API not available!");                    
                        return false;
                    }

                    // check presence of payment information
                    handler.payment = handler.toSimplifyPayment(handler.operation, configuration, quote);
                    if (handler.payment && handler.payment.isValid) {
                        // callback where result of payment operation is returned
                        handler.onCardProcessed = onCardProcessed;
                        // Initialize Simplify Hosted Payments form
                        handler.isValid = handler.initializeHostedPayments(container);
                        
                    }
                    else {
                        handler.payment = null;
                        handler.onCardProcessed = null;
                        handler.hostedPayments = null;
                    }

                    return handler.isValid;
                },

                /** Initializes Simplify Commerce Hosted Payments form */
                initializeHostedPayments: function(container) {
                    var result = false;
                    if (container) {
                        handler.hostedPayments = SimplifyCommerce.hostedPayments(handler.onSimplifyResponse, handler.payment, container);
                        result = true;
                    }
                    else {
                        log.error("The required UI components not found!");                    
                    }
                    return result;
                },


                /** Enables pay button, usually called after failed operations 
                  * to allow user to correct problems and resubmit the payment */
                enablePayButton: function() {
                    if (handler.hostedPayments) {
                        handler.hostedPayments.enablePayBtn();
                    }
                },


                /** Called when Simplify Commerce returns from payment/tokenize operation */
                onSimplifyResponse: function(response) {
                    if (response) {
                        var payment = handler.toMagentoPayment(response);
                        // if card verification failed, allow correcting errors and running the payment again
                        if (!(payment && payment.success)) {
                            if (handler.hostedPayments) {
                                handler.hostedPayments.enablePayBtn();
                            }
                        }
                        if (handler.onCardProcessed) {
                            handler.onCardProcessed(payment);
                        }
                    }
                },


                /** Extracts order data, returns a Simplify Commerce payment object */
                toSimplifyPayment: function(operation, configuration, quote) {
                    var payment = null;
                    if (operation && configuration && quote) {
                        if (configuration.isCustomerLoggedIn) {
                            // actions which require the customer to be logged in ...
                        }
                        var total = quote.totals();
                        var billingAddress = quote.billingAddress() || {};
                        payment = {
                            scKey: clean(configuration.publicKey),
                            color: "#1979C3",
                            name: clean(configuration.storeName, "Magento Store"),
                            receipt: true,
                            masterpass: false,
                            description: clean(configuration.storeName, "Magento Store"),
                            operation: clean(operation),
                            customerName: configuration.isCustomerLoggedIn ? 
                                            clean(configuration.customer.name, billingAddress.company) : 
                                            clean(concatenate(billingAddress.firstname, billingAddress.lastname), billingAddress.company),
                            customerEmail: configuration.isCustomerLoggedIn ? 
                                            clean(configuration.customer.email) : 
                                            clean(quote.guestEmail),
                            reference: "#" + clean(quote.getQuoteId()),
                            amount: clean(total.grand_total * 100, 0),
                            currency: clean(total.base_currency_code),
                            address: clean(concatenate(billingAddress.street)),
                            addressCity: clean(billingAddress.city),
                            addressCountry: clean(billingAddress.countryId),
                            addressState: clean(billingAddress.region),
                            addressZip: clean(billingAddress.postcode)
                        };
                        payment.isValid = payment.amount > 0 && payment.currency;
                    }
                    return payment;
                },


                /** Extracts the data from SimplifyCommerce payment, as required by Magento Payment class */
                toMagentoPayment: function(payment) {
                    var result = { success: false };
                    if (payment && payment.card) {
                        result = {
                            "success": handler.hasPaymentSucceeded(handler.operation, payment),
                            "cc-token": clean(payment.cardToken),
                            "cc-last4": clean(payment.card.last4),
                            "cc-expiration-month": payment.card.expMonth,
                            "cc-expiration-year": payment.card.expYear,
                            "cc-type": clean(handler.toMagentoCardType(payment.card.type))
                        };
                    };
                    return result;
                },


                /** Returns true if Simplify Commerce payment operation has succeeded */
                hasPaymentSucceeded: function(operation, payment) {
                    var result = false;
                    if (operation && payment) {
                        switch (operation) {
                            case "create.payment": 
                                result = payment.paymentStatus === "APPROVED";
                                break;

                            case "create.token": 
                                result = Boolean(payment.cardToken && payment.cardToken.trim().length);
                                break;
                        }
                    }
                    return result;
                },


                /** Maps Simplify Commerce card type to Magento card types */
                toMagentoCardType: function(cardType) {
                    var result = null;
                    if (cardType) {
                        var types = {
                            VISA: "VI",
                            MASTERCARD: "MC",
                            AMEX: "AE",
                            JCB: "JCB",
                            DISCOVER: "DI",
                            DINERS: "DN"
                        };
                        result = types[cardType.toString().toUpperCase()] || cardType;
                    }
                    return result;
                }

            };


            /** Concatenates the received string values, separating them with space.
             *  Input can be an open list of string arguments, or an array */
            function concatenate() {
                var items = arguments;
                if (items.length === 1 && items[0] instanceof Array) {
                    items = items[0];
                }
                return __.filter(items, function(item) {
                    return item && item.toString().trim() !== "";
                }).join(" ");
            }


            /** Returns null or defaultValue, if the specified value is undefined, null or empty string */
            function clean(value, defaultValue) {
                if (!value || value.toString().trim() === "") 
                    return defaultValue || undefined;
                else
                    return value.toString();
            }


            handler.initialize(configuration, quote, onCardProcessed);
            return handler;
        }

        component.configuration = component.getConfiguration();
        return Component.extend(component);
    }
);


