import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { MemberValidationUtil } from '../utils';

@ValidatorConstraint({ async: false })
export class IsValidAadharConstraint implements ValidatorConstraintInterface {
  validate(aadharNumber: string, args: ValidationArguments) {
    return MemberValidationUtil.isValidAadhar(aadharNumber);
  }

  defaultMessage(args: ValidationArguments) {
    return 'Aadhar number must be 12 digits';
  }
}

@ValidatorConstraint({ async: false })
export class IsValidPANConstraint implements ValidatorConstraintInterface {
  validate(panNumber: string, args: ValidationArguments) {
    return MemberValidationUtil.isValidPAN(panNumber);
  }

  defaultMessage(args: ValidationArguments) {
    return 'PAN number must be in format ABCDE1234F';
  }
}

@ValidatorConstraint({ async: false })
export class IsValidPhoneNumberConstraint implements ValidatorConstraintInterface {
  validate(phoneNumber: string, args: ValidationArguments) {
    return MemberValidationUtil.isValidPhoneNumber(phoneNumber);
  }

  defaultMessage(args: ValidationArguments) {
    return 'Phone number must be a valid Indian mobile number';
  }
}

@ValidatorConstraint({ async: false })
export class IsValidAgeConstraint implements ValidatorConstraintInterface {
  validate(dateOfBirth: string, args: ValidationArguments) {
    return MemberValidationUtil.isValidAge(new Date(dateOfBirth));
  }

  defaultMessage(args: ValidationArguments) {
    return 'Member must be between 18 and 100 years old';
  }
}

// Decorator functions
export function IsValidAadhar(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidAadharConstraint,
    });
  };
}

export function IsValidPAN(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidPANConstraint,
    });
  };
}

export function IsValidPhoneNumber(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidPhoneNumberConstraint,
    });
  };
}

export function IsValidAge(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidAgeConstraint,
    });
  };
}
